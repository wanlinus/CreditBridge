import type { Account, CheckinRecord, CheckinStatus, Credits } from '../../types.ts';
import { usableCredential } from '../../core/accounts.ts';
import { keepEarlierSuccess, readCheckinState, writeCheckinState as writeCheckinStore } from '../../core/checkin-store.ts';
import { refreshQoderCredential, type QoderCredential } from './auth.ts';

const BASE = 'https://openapi.qoder.com.cn';
const USAGE_PATH = '/sash/api/v2/me/usage';
const CAMPAIGNS_PATH = '/sash/api/v1/me/campaigns';
const CHINA_OFFSET_MINUTES = 8 * 60;
const WINDOW_OPEN_HOUR = 10;

let logSink: any = null;
export function setQoderUsageLogger(fn: any) {
  logSink = fn;
}
function log(...args: unknown[]) {
  if (logSink) logSink(`[qoder-usage] ${args.join(' ')}`);
}

function authHeaders(credential: QoderCredential): Record<string, string> {
  return {
    Authorization: `Bearer ${credential.token}`,
    Accept: 'application/json',
  };
}

async function callApi(account: Account, pathname: string, init: RequestInit = {}): Promise<any> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const credential = await usableCredential(account, refreshQoderCredential, { forceRefresh: attempt > 0 });
    const response = await fetch(`${BASE}${pathname}`, {
      ...init,
      headers: { ...authHeaders(credential), ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(30000),
    });
    const text = await response.text();
    if (response.status === 401 && attempt === 0) {
      log(`${account.id} ${pathname} 401，续期凭据后重试`);
      continue;
    }
    if (!response.ok) {
      let detail = text.slice(0, 300);
      try {
        const doc = JSON.parse(text);
        detail = doc.errorMessage || doc.message || doc.code || detail;
      } catch {
      }
      throw new Error(`Qoder ${pathname} HTTP ${response.status}: ${detail}`);
    }
    if (text === '') return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Qoder ${pathname} 返回的不是 JSON: ${text.slice(0, 200)}`);
    }
  }
  throw new Error(`Qoder ${pathname} 鉴权失败`);
}

export async function getQoderCredits(account: Account): Promise<Credits> {
  const credential = await usableCredential(account, refreshQoderCredential);
  const doc = await callApi(account, USAGE_PATH);
  const usage = doc && doc.qoderUsage ? doc.qoderUsage : {};
  const userQuota = usage.userQuota || {};
  const addOnQuota = usage.addOnQuota || {};

  const toPackage = (name: string, quota: any) => ({
    name,
    limit: Number(quota.total) || 0,
    used: Number(quota.used) || 0,
    expireAt: null,
  });

  const packages = [
    toPackage('套餐额度', userQuota),
    toPackage('加购额度', addOnQuota),
  ];

  return {
    provider: account.channelId,
    supported: true,
    totalRemain: packages.reduce((sum, item) => sum + Math.max(0, item.limit - item.used), 0),
    packages,
    account: {
      uid: credential.userId,
      username: credential.username || '',
      domain: 'qoder.com.cn',
      tokenExpiresAt: credential.expiresAt || null,
      source: credential.source,
    },
    userType: usage.userType,
    isQuotaExceeded: usage.isQuotaExceeded === true,
    planExpiresAt: usage.expiresAt,
  } as Credits;
}

interface Campaign {
  campaignId: string;
  campaignKey?: string;
  actionType?: string;
  claimStatus?: string;
  startAt?: number;
  endAt?: number;
  benefit?: {
    kind?: string;
    amount?: number;
    validity?: { mode?: string; days?: number };
  };
}

function pickCampaigns(doc: any): Campaign[] {
  const list = doc && Array.isArray(doc.campaigns) ? doc.campaigns : [];
  return list.filter(
    (item: any) =>
      item &&
      typeof item.campaignId === 'string' &&
      (item.claimStatus === undefined || item.claimStatus === 'CLAIMABLE') &&
      (item.actionType === undefined || item.actionType === 'CLAIM_BENEFIT'),
  );
}

export async function listClaimableCampaigns(account: Account): Promise<Campaign[]> {
  return pickCampaigns(await callApi(account, CAMPAIGNS_PATH));
}

export async function getCheckinStatus(account: Account): Promise<CheckinStatus> {
  const doc = await callApi(account, CAMPAIGNS_PATH);
  const campaigns = pickCampaigns(doc);
  const first = campaigns[0];
  const checkedIn = !(doc && doc.claimable === true) && campaigns.length === 0;
  return {
    enable: true,
    checkedIn,
    credits: first && first.benefit && typeof first.benefit.amount === 'number' ? first.benefit.amount : 0,
    extraCredits: 0,
    didCheckedIn: checkedIn,
  };
}

function checkinDate(): string {
  const now = new Date();
  const shifted = new Date(now.getTime() + (CHINA_OFFSET_MINUTES + now.getTimezoneOffset()) * 60 * 1000);
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, '0')}-${String(shifted.getDate()).padStart(2, '0')}`;
}

export function isBeforeCheckinWindow(at: number = Date.now()): boolean {
  const now = new Date(at);
  const shifted = new Date(now.getTime() + (CHINA_OFFSET_MINUTES + now.getTimezoneOffset()) * 60 * 1000);
  return shifted.getHours() < WINDOW_OPEN_HOUR;
}

export async function claimCheckin(account: Account): Promise<CheckinRecord> {
  const today = checkinDate();
  const previous = readCheckinState(account);
  if (previous && previous.date === today && previous.status === 'checked') {
    log(`${account.id} 今天已经领过，跳过`);
    return { ...previous, outcome: 'already' };
  }

  let record: CheckinRecord;
  try {
    const campaigns = await listClaimableCampaigns(account);
    if (campaigns.length === 0) {
      if (isBeforeCheckinWindow()) {
        record = {
          date: today,
          status: 'pending',
          message: `今天这一轮还没开始（活动每天 ${WINDOW_OPEN_HOUR}:00 开新窗口）`,
          at: Date.now(),
        };
        log(`${account.id} 窗口未开，记 pending（调度器会在重试阶梯里再试）`);
      } else {
        record = {
          date: today,
          status: 'already',
          message: '当前没有可领取的签到活动',
          at: Date.now(),
        };
        log(`${account.id} 没有可领活动，按已签处理`);
      }
    } else {
      const campaign = campaigns[0];
      const doc = await callApi(account, `${CAMPAIGNS_PATH}/${encodeURIComponent(campaign.campaignId)}/claim`, {
        method: 'POST',
      });
      const replayed = doc && doc.replayed === true;
      const amount =
        (doc && doc.benefit && typeof doc.benefit.amount === 'number' && doc.benefit.amount) ||
        (campaign.benefit && typeof campaign.benefit.amount === 'number' && campaign.benefit.amount) ||
        0;
      record = {
        date: today,
        status: replayed ? 'already' : 'checked',
        credits: amount,
        extraCredits: 0,
        streakDays: null,
        message: replayed ? '今天已经领过' : `签到成功，获得 ${amount} Credits`,
        at: Date.now(),
        outcome: replayed ? 'replayed' : 'claimed',
      };
      log(`${account.id} 签到 ${record.status} campaignKey=${campaign.campaignKey || '?'} amount=${amount} replayed=${replayed}`);
      callApi(account, `/sash/api/v1/me/notifications/${encodeURIComponent(campaign.campaignId)}/read`, {
        method: 'POST',
      }).catch((error) => log(`标记已读失败（不影响发放）：${error.message}`));
    }
  } catch (error: any) {
    record = { date: today, status: 'error', message: error.message, at: Date.now() };
    log(`${account.id} 签到失败：${error.message}`);
  }

  const earlier = keepEarlierSuccess(account, today, record);
  if (earlier) {
    log(`${account.id} 签到 ${record.status}：保留当天已有的成功记录（${earlier.credits} credits）`);
    return { ...earlier, outcome: record.status };
  }

  if (!writeCheckinStore(account, record)) log(`${account.id} 签到状态写入失败`);
  return record;
}

export function readLastCheckin(account: Account): CheckinRecord | null {
  return readCheckinState(account);
}
