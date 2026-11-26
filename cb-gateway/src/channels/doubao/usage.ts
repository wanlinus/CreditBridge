// 豆包额度与每日签到。
//
// 额度：`/alice/commerce/sale/subscription/quota/summary/`，body `{"product_line":"membership"}`。
// 一个必须处理的坑：**三个金额字段都是带千分位逗号的字符串**（`"2,142"`），
// `Number("2,142")` 是 `NaN`。不做这个处理余额会显示「—」而不是报错——
// `NaN` 被 `Number.isFinite` 挡掉，看起来像「上游没返回」，实际是解析错了。
//
// 签到：`/alice/ug/campaign/landing/checkin`，body `{"scene":"pc_incentive_task_mvp_v3"}`。
// 逆向见 `private/docs/recon/doubao-checkin.md`。

import type { Account, CheckinRecord, Credits, UsagePackage } from '../../types.ts';
import { localDate } from '../../shared/clock.ts';
import { usableCredential } from '../../core/accounts.ts';
import { keepEarlierSuccess, readCheckinState, writeCheckinState } from '../../core/checkin-store.ts';
import { asCredentialError } from '../../shared/credential-error.ts';
import { UpstreamError } from '../../shared/upstream-error.ts';
import { DOUBAO_VERSION, postWeb, refreshDoubaoCredential } from './auth.ts';

const QUOTA_PATH = '/alice/commerce/sale/subscription/quota/summary/';
const CHECKIN_PATH = '/alice/ug/campaign/landing/checkin';

/** PC 端活动 ID。客户端 `83347.js` 里 `pc_incentive_task_mvp_v3`。 */
const CHECKIN_SCENE = 'pc_incentive_task_mvp_v3';

let logSink: any = null;
export function setUsageLogger(fn: any) {
  logSink = fn;
}
function log(...args: unknown[]) {
  if (logSink) logSink(`[doubao-usage] ${args.join(' ')}`);
}

/** `"2,142"` → `2142`。不是数字时返回 `null`，**不要用 0 兜底**——0 是合法余额。 */
function amountOf(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const cleaned = raw.replace(/,/g, '').trim();
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** 拉一次余额。失败**直接抛**，路由会包成 `{supported:false, error}` 仍回 200。 */
export async function getCredits(account: Account): Promise<Credits> {
  let credential;
  try {
    credential = await usableCredential(account, refreshDoubaoCredential);
  } catch (error: any) {
    throw asCredentialError(error, '豆包凭据不可用') ?? error;
  }

  const doc = await postWeb(credential, QUOTA_PATH, { product_line: 'membership' });
  if (Number(doc?.code) !== 0) {
    // 登录态失效这里会回 710012001，映射成 401 让路由标 invalid。
    const code = Number(doc?.code);
    if (code === 710012001 || code === 710010202) {
      throw new UpstreamError(401, `豆包登录态失效（上游 ${code}），请重新导入 cookie`, {
        code: 'doubao_login_expired',
      });
    }
    throw new UpstreamError(502, `豆包额度接口返回 ${code}：${doc?.msg || doc?.message || '未知错误'}`, {
      code: `doubao_quota_${code}`,
    });
  }

  const data = doc?.data;
  if (!data || typeof data !== 'object') {
    throw new UpstreamError(502, '豆包额度接口没有返回 data', { code: 'doubao_quota_empty' });
  }

  const totalRemain = amountOf(data.quota_remaining_amount);
  if (totalRemain === null) {
    // 读不到余额要抛错，**不要 `?? 0` 兜底**——那会让界面显示「剩余 0」像是额度用光了。
    throw new UpstreamError(502, `豆包额度接口没返回有效的 quota_remaining_amount`, { code: 'doubao_quota_no_amount' });
  }

  const subscription = data.current_subscription && typeof data.current_subscription === 'object' ? data.current_subscription : {};
  const endTime = Number(subscription.end_time);
  const expireAt = Number.isFinite(endTime) && endTime > 0 ? endTime : null;

  // `quota_blance_usage` 里的 `blance` 是上游拼错的，别改成 balance。
  const usageRows = Array.isArray(data.quota_blance_usage) ? data.quota_blance_usage : [];
  const packages: UsagePackage[] = [];
  for (const row of usageRows) {
    if (!row || typeof row !== 'object') continue;
    const limit = amountOf(row.total_amount);
    const used = amountOf(row.used_amount);
    if (limit === null || used === null) continue;
    packages.push({
      name: String(row.title || `类别 ${row.category ?? '?'}`),
      limit,
      used,
      expireAt,
    });
  }

  const display = subscription.display && typeof subscription.display === 'object' ? subscription.display : {};
  log(
    `${account.id} 可用 ${totalRemain}` +
      (packages.length > 0 ? `（${packages.map((p) => `${p.name} ${p.used}/${p.limit}`).join('、')}）` : ''),
  );

  return {
    provider: account.channelId,
    supported: true,
    totalRemain,
    packages,
    account: {
      uid: credential.uid || account.profile?.uid,
      username: account.profile?.username || '',
      domain: 'doubao.com',
      tokenExpiresAt: credential.expiresAt ? new Date(credential.expiresAt).toISOString() : null,
      source: credential.source,
    },
    // 订阅信息单独带出来：`/api/accounts/<id>/credits` 会原样透传，界面可以显示套餐名。
    subscription: {
      name: String(display.short_name || display.product_name || ''),
      endTime: expireAt,
      isGift: subscription.is_gift === true,
    },
  };
}

/** 上游签到响应里我们关心的字段。只读其中四个，其余留着是为了排查时能看全貌。 */
interface CheckinReply {
  checked_in?: boolean;
  checkin_date?: string;
  continuous_days?: number;
  idempotent?: boolean;
  reward_amount?: number;
  reward_code?: string;
  reward_status?: number;
  reward_type?: string;
}

/** 读本地签到记录。**同步、不发网络请求**——豆包没有只读的签到查询接口。 */
export function readLastCheckin(account: Account): CheckinRecord | null {
  return readCheckinState(account);
}

/**
 * 领今日签到。**幂等由上游保证**：今天签过再调回 `idempotent: true` 而不是报错，
 * 所以映射成 `already`，不算失败——当成失败会让调度器一直重试、日志里全是假失败。
 */
export async function claimCheckin(account: Account): Promise<CheckinRecord> {
  const date = localDate();

  // `pc_version` 空 → 上游回 710010702，而那个码看起来像 cookie 过期。
  // 与其让上游吐一个误导性的错误，不如在这里自己说清楚。
  if (!DOUBAO_VERSION) {
    log(`${account.id} 跳过签到：客户端版本号为空（pc_version 会发空值，上游必回 710010702）`);
    return {
      date,
      status: 'error',
      message: '豆包客户端版本号还没加载出来，稍后重试（重启网关可立即恢复）',
    };
  }

  let credential;
  try {
    credential = await usableCredential(account, refreshDoubaoCredential);
  } catch (error: any) {
    const failure = asCredentialError(error, '豆包凭据不可用') ?? error;
    return { date, status: 'error', message: String(failure?.message || failure) };
  }

  let doc: any;
  try {
    doc = await postWeb(credential, CHECKIN_PATH, { scene: CHECKIN_SCENE });
  } catch (error: any) {
    log(`${account.id} 签到请求失败：${error?.message || error}`);
    return { date, status: 'error', message: String(error?.message || error), transient: true };
  }

  const code = Number(doc?.code);
  const data = (doc?.data ?? null) as CheckinReply | null;

  if (code !== 0 || !data) {
    const message = String(doc?.msg || doc?.message || '').trim() || `上游 ${code}`;
    // 710010702 常见于「query 参数不全」，不是 cookie 问题。单独说明，免得误导。
    const hint = code === 710010702 ? '（上游系统错误，通常是请求参数不全）' : '';
    log(`${account.id} 签到失败 code=${code} msg=${message}`);
    return { date, status: 'error', message: `${message}${hint}`, upstreamCode: code };
  }

  const reward = Number(data.reward_amount) || 0;
  const streak = Number(data.continuous_days) || null;

  // 上游对重复签到回 200 + idempotent，不是失败。
  if (data.idempotent === true) {
    const record: CheckinRecord = { date, status: 'already', credits: reward, streakDays: streak, message: '今天已经签到过了' };
    // 今天真签到过就别被「already」覆盖——那条记录是唯一存着「今天得了多少额度」的地方。
    const kept = keepEarlierSuccess(account, date, record) ?? record;
    if (!writeCheckinState(account, kept)) log(`${account.id} 签到状态写入失败`);
    log(`${account.id} 今天已签过（连续 ${streak ?? '?'} 天），不重复发奖`);
    return kept;
  }

  if (data.checked_in !== true) {
    log(`${account.id} 上游既没报错也没签上（checked_in=${data.checked_in}）`);
    return { date, status: 'error', message: '上游没有确认签到成功' };
  }

  const record: CheckinRecord = {
    date,
    status: 'checked',
    credits: reward,
    streakDays: streak,
    message: `+${reward} 额度`,
  };
  if (!writeCheckinState(account, record)) log(`${account.id} 签到状态写入失败`);
  log(`${account.id} 签到成功：+${reward} 额度，连续 ${streak ?? '?'} 天`);
  return record;
}
