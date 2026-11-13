import type { Account, CheckinRecord, CheckinStatus, Credits } from '../../types.ts';
import { localDate } from '../../shared/clock.ts';
import { usableCredential } from '../../core/accounts.ts';
import { keepEarlierSuccess, readCheckinState, writeCheckinState } from '../../core/checkin-store.ts';
import { effectiveDeviceId, refreshTraeCredential, TRAE_APP_VERSION } from './auth.ts';

const ACCOUNT_BASE = 'https://api.trae.cn';
const USAGE_PATH = '/trae/api/v2/pay/ide_user_ent_usage';
const CHECKIN_STATUS_PATH = '/trae/api/v2/ug/checkin_credits/status';
const CHECKIN_CLAIM_PATH = '/trae/api/v2/ug/checkin_credits/claim';

const USAGE_TTL_MS = 20_000;

let logSink: any = null;
export function setTraeUsageLogger(fn: any) {
  logSink = fn;
}
function log(...args: unknown[]) {
  if (logSink) logSink(`[trae-usage] ${args.join(' ')}`);
}

async function postAccount(account: Account, pathname: any, body: any) {
  const credential = await usableCredential(account, refreshTraeCredential);
  const deviceId = effectiveDeviceId(credential);
  const response = await fetch(`${ACCOUNT_BASE}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Cloud-IDE-JWT ${credential.token}`,
      'x-device-id': deviceId,
      'x-app-version': TRAE_APP_VERSION,
      'x-device-type': 'windows',
      'x-os-version': 'Windows 10',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(`Trae account API returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`);
  }
  if (!response.ok) throw new Error(`Trae account API http ${response.status}: ${text.slice(0, 200)}`);
  if (typeof doc.code === 'number' && doc.code !== 0) {
    if (doc.code === 9004 && !deviceId) {
      throw withUpstreamCode(
        new Error(`Trae account API code 9004: ${doc.message || ''}（x-device-id 为空：这套凭据既没有 aha 注册号也没有自造号）`),
        doc.code,
      );
    }
    throw withUpstreamCode(new Error(`Trae account API code ${doc.code}: ${doc.message || ''}`), doc.code);
  }
  return doc;
}

const TRANSIENT_BIZ_CODES = new Set([9074]);

function withUpstreamCode(error: Error, code: number) {
  const tagged: any = error;
  tagged.upstreamCode = code;
  tagged.transient = TRANSIENT_BIZ_CODES.has(code);
  return tagged;
}

const usageCache = new Map<string, { at: number; value: any }>();
const usageInFlight = new Map<string, Promise<any>>();

export async function getTraeUsage(account: Account, options: { force?: boolean } = {}): Promise<Credits> {
  const cached = usageCache.get(account.id);
  if (!options.force && cached && cached.value && Date.now() - cached.at < USAGE_TTL_MS) return cached.value;
  const running = usageInFlight.get(account.id);
  if (running) return running;
  const task = (async () => {
    const doc = await postAccount(account, USAGE_PATH, { require_usage: true, req_source: 1 });
    const summary = doc.usage_summary && typeof doc.usage_summary === 'object' ? doc.usage_summary : {};
    const total = Number(summary.total_amount) || 0;
    const consumed = Number(summary.consumed_amount) || 0;
    const packs = Array.isArray(doc.user_entitlement_pack_list) ? doc.user_entitlement_pack_list : [];
    const value = {
      provider: account.channelId,
      supported: true,
      currency: 'credits',
      total,
      consumed: Number(consumed.toFixed(4)),
      remaining: Number(Math.max(0, total - consumed).toFixed(4)),
      totalRemain: Number(Math.max(0, total - consumed).toFixed(4)),
      ratio: Number(summary.consumption_ratio) || (total > 0 ? consumed / total : 0),
      isCreditsBilling: doc.is_credits_billing === true,
      trial: doc.trial_status && typeof doc.trial_status === 'object' ? doc.trial_status : null,
      packages: packs
        .filter((pack: any) => pack && typeof pack === 'object' && pack.is_hide !== true)
        .map((pack: any) => {
          const base = pack.entitlement_base_info && typeof pack.entitlement_base_info === 'object' ? pack.entitlement_base_info : {};
          const quota = base.quota && typeof base.quota === 'object' ? base.quota : {};
          const used = pack.usage && typeof pack.usage === 'object' ? pack.usage : {};
          return {
            name: typeof pack.display_desc === 'string' && pack.display_desc !== '' ? pack.display_desc : (base.product_extra?.package_extra?.package_name || '积分包'),
            limit: Number(quota.credits_limit) || 0,
            used: Number(used.credits_amount) || 0,
            expireAt: Number(pack.expire_time) ? Number(pack.expire_time) * 1000 : null,
            group: typeof pack.group_name === 'string' ? pack.group_name : '',
          };
        }),
      fetchedAt: Date.now(),
    };
    usageCache.set(account.id, { at: Date.now(), value });
    return value;
  })();
  usageInFlight.set(account.id, task);
  try {
    return await task;
  } finally {
    usageInFlight.delete(account.id);
  }
}

function invalidateTraeUsage(account: Account) {
  usageCache.delete(account.id);
}

export async function getCheckinStatus(account: Account): Promise<CheckinStatus> {
  const doc = await postAccount(account, CHECKIN_STATUS_PATH, { req_source: 1 });
  return {
    enable: doc.enable === true,
    checkedIn: doc.checked_in === true,
    credits: Number(doc.credits) || 0,
    extraCredits: Number(doc.extra_credits) || 0,
    didCheckedIn: doc.did_checked_in === true,
  };
}

export async function claimCheckin(account: Account): Promise<CheckinRecord> {
  const today = localDate();
  let outcome: CheckinRecord;
  let transient = false;
  try {
    const status = await getCheckinStatus(account);
    if (!status.enable) {
      outcome = { date: today, status: 'disabled', message: 'Trae 未开放签到', at: Date.now() };
    } else if (status.checkedIn) {
      outcome = {
        date: today,
        status: 'already',
        credits: status.credits,
        message: '今天已签到',
        at: Date.now(),
      };
    } else {
      const doc = await postAccount(account, CHECKIN_CLAIM_PATH, { req_source: 1 });
      const after = await getCheckinStatus(account).catch(() => null);
      outcome = {
        date: today,
        status: 'checked',
        credits: after ? after.credits : status.credits,
        extraCredits: after ? after.extraCredits : status.extraCredits,
        message: doc.message || '签到成功',
        at: Date.now(),
      };
      log(`${account.id} checkin success credits=${outcome.credits} extra=${outcome.extraCredits}`);
      invalidateTraeUsage(account);
    }
  } catch (error: any) {
    const after = await getCheckinStatus(account).catch(() => null);
    if (after && after.checkedIn) {
      outcome = {
        date: today,
        status: 'already',
        credits: after.credits,
        extraCredits: after.extraCredits,
        message: '今天已签到',
        at: Date.now(),
      };
      log(`${account.id} checkin 报错但服务端已签到（${error.message}），按已签到记`);
    } else {
      outcome = { date: today, status: 'error', message: error.message, at: Date.now() };
      transient = error.transient === true;
      log(`${account.id} checkin error: ${error.message}`);
    }
  }

  const earlier = keepEarlierSuccess(account, today, outcome);
  if (earlier) return { ...earlier, outcome: outcome.status, transient };

  if (!writeCheckinState(account, outcome)) log(`${account.id} checkin state write failed`);
  return { ...outcome, outcome: outcome.status, transient };
}

export function readLastCheckin(account: Account): CheckinRecord | null {
  return readCheckinState(account);
}
