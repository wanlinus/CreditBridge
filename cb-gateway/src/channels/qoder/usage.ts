// Qoder 的额度与每日签到，接口全在 `openapi.qoder.com.cn` 的 `/sash/*`。
// 坑：产品内部把签到叫 campaign（猜 `/me/checkin` 全 404），且 `campaignId` 每轮都换，必须现查现领。

import type { Account, CheckinRecord, CheckinStatus, Credits } from '../../types.ts';
import { usableCredential } from '../../core/accounts.ts';
import { keepEarlierSuccess, readCheckinState, writeCheckinState as writeCheckinStore } from '../../core/checkin-store.ts';
import { OPENAPI_BASE, TIMEOUT_MS, refreshQoderCredential, type QoderCredential } from './auth.ts';

const USAGE_PATH = '/sash/api/v2/me/usage';
const CAMPAIGNS_PATH = '/sash/api/v1/me/campaigns';
/**
 * 活动窗口每天北京时间 **10:00** 开、次日 09:59 截止。这一点直接决定了 `config.checkinTime`
 * 默认定在 10:05：定在窗口开启前去领会拿到空 `campaigns`，被记成「没有可领的活动」而面板一片正常。
 */
const CHINA_OFFSET_MINUTES = 8 * 60;
/** 活动窗口每天 10:00（北京时间）开启。 */
const WINDOW_OPEN_HOUR = 10;

let logSink: any = null;
export function setUsageLogger(fn: any) {
  logSink = fn;
}
function log(...args: unknown[]) {
  if (logSink) logSink(`[qoder-usage] ${args.join(' ')}`);
}

function authHeaders(credential: QoderCredential): Record<string, string> {
  // 和官方 CLI 一致：`/sash` 接口只带 Accept + Authorization，不带 User-Agent / Content-Type。
  return {
    Authorization: `Bearer ${credential.token}`,
    Accept: 'application/json',
    // 少了 `cosy-clienttype`，上游对 `/sash/api/v1/me/campaigns` 会**静默返回空**
    // （`{"showCampaign":false,"claimable":false,"campaigns":[]}`），和「今天已领完」逐字节相同，
    // 于是每次签到都被记成 `already`、一次都没真领过，而界面一切正常。值必须是 10，别的值不行。
    'cosy-clienttype': '10',
  };
}

/** 发一个带鉴权的请求；401 时强制续期一次再试。 */
async function callApi(account: Account, pathname: string, init: RequestInit = {}): Promise<any> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const credential = await usableCredential(account, refreshQoderCredential, { forceRefresh: attempt > 0 });
    const response = await fetch(`${OPENAPI_BASE}${pathname}`, {
      ...init,
      headers: { ...authHeaders(credential), ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    if (response.status === 401 && attempt === 0) {
      // 令牌可能刚过期。强制刷新一次通常就有新的（drt- 换 dt-）。
      log(`${account.id} ${pathname} 401，续期凭据后重试`);
      continue;
    }
    if (!response.ok) {
      let detail = text.slice(0, 300);
      try {
        const doc = JSON.parse(text);
        detail = doc.errorMessage || doc.message || doc.code || detail;
      } catch {
        /* 不是 JSON，用原文 */
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

/**
 * 额度快照。**`userQuota` 和 `addOnQuota` 不能相加**：前者是套餐额度、后者是加购/活动额度
 * （签到就进这里），语义和过期时间都不同。`totalRemain` 给徽标用，两块明细放 `packages`。
 */
export async function getCredits(account: Account): Promise<Credits> {
  const credential = await usableCredential(account, refreshQoderCredential);
  const doc = await callApi(account, USAGE_PATH);
  const usage = doc && doc.qoderUsage ? doc.qoderUsage : {};
  const userQuota = usage.userQuota || {};
  const addOnQuota = usage.addOnQuota || {};

  // 归一成 UsagePackage（`name` / `limit` / `used` / `expireAt`）：透传上游字段名会让面板那张
  // 「积分包」表整行渲染成 `undefined / — / 0 / —`。
  const toPackage = (name: string, quota: any) => ({
    name,
    limit: Number(quota.total) || 0,
    used: Number(quota.used) || 0,
    expireAt: null,
  });

  const packages = [
    toPackage('套餐额度', userQuota),
    // 加购额度为 0 时也列出来：面板要能看出「签到一次就能有 100」。
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

/** 一个可领的活动。 */
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

/**
 * 列出当轮还没领的活动。`campaigns` 里混有已完成的历史项，所以按 `claimStatus` /
 * `actionType` 过滤，而不是「取第一个」。
 */
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

/** 上游签到状态，**只能推断**：领完后那条变 `CLAIMED`，接口不返回「今天领过什么、领了多少」。 ⚠️ `campaigns: []` **不等于「已签到」**——请求头不对时上游静默回空，和「今天领完了」逐字节相同。
 * 所以只把 `claimable === true` 当正面信号，其余一律按未签处理，让调用方去走 pending/error 分支。 */
export async function getCheckinStatus(account: Account): Promise<CheckinStatus> {
  const doc = await callApi(account, CAMPAIGNS_PATH);
  const campaigns = pickCampaigns(doc);
  // 只有上游明确说 claimable、或列表里真有一条可领的，才算「没签」；空列表不替上游下「已签」的结论。
  const claimable = (doc && doc.claimable === true) || campaigns.length > 0;
  const first = campaigns[0];
  return {
    enable: true,
    checkedIn: !claimable,
    credits: first && first.benefit && typeof first.benefit.amount === 'number' ? first.benefit.amount : 0,
    extraCredits: 0,
    didCheckedIn: !claimable,
  };
}

/** 本机日历日，用来让签到幂等。用**北京时间**而不是本机时区：窗口按北京时间 10:00 切。 */
function checkinDate(): string {
  const now = new Date();
  const shifted = new Date(now.getTime() + (CHINA_OFFSET_MINUTES + now.getTimezoneOffset()) * 60 * 1000);
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, '0')}-${String(shifted.getDate()).padStart(2, '0')}`;
}

/**
 * 现在是不是**在今天窗口开启之前**（窗口每天 10:00 开、次日 09:59 截止；凌晨 00:30 属于
 * 昨天那一轮的尾巴）。上游在「今天已领过」和「今天这轮还没开始」两种情况下都返回
 * `campaigns: []`，混为一谈会让面板显示正常而一分没领到，所以窗口没开时返回 `pending`——
 * 调度器的 `settledForToday()` 不把 `pending` 当结论，会把它收进重试阶梯。
 * @param at 参数化是为了能测这个只在 10:00 前才走到的分支。
 */
export function isBeforeCheckinWindow(at: number = Date.now()): boolean {
  const now = new Date(at);
  const shifted = new Date(now.getTime() + (CHINA_OFFSET_MINUTES + now.getTimezoneOffset()) * 60 * 1000);
  return shifted.getHours() < WINDOW_OPEN_HOUR;
}

/** 领今天的签到奖励：先列活动拿 `campaignId` 再 POST。**不能盲发 POST**——没有可领项时上游回 400 `FIELD_VALIDATION_FAILED`，那不是「今天已签」而是「参数不对」。
 * 上游对同一 `campaignId` 重复 POST 返回 `replayed: true` 且不重复发放，所以重试安全。 */
export async function claimCheckin(account: Account): Promise<CheckinRecord> {
  const today = checkinDate();
  const previous = readCheckinState(account);
  if (previous && previous.date === today && previous.status === 'checked') {
    log(`${account.id} 今天已经领过，跳过`);
    return { ...previous, outcome: 'already' };
  }

  let record: CheckinRecord;
  // 默认不可重试；只有「上游回空但拿不到 claimable 信号」那种可疑情况才置 true，
  // 让调度器多给几档机会（`test:checkin-scheduler` 钉的是「只有 transient 才走密集阶梯」）。
  let transient = false;
  try {
    // 直接读原始文档而不是 `listClaimableCampaigns()`：要用 `claimable` / `showCampaign`
    // 判断「是真空还是请求没被认」，只拿过滤后的数组会丢掉这个信息。
    const doc = await callApi(account, CAMPAIGNS_PATH);
    const campaigns = pickCampaigns(doc);
    const claimable = doc && doc.claimable === true;
    if (campaigns.length === 0) {
      if (isBeforeCheckinWindow()) {
        record = {
          date: today,
          status: 'pending',
          message: `今天这一轮还没开始（活动每天 ${WINDOW_OPEN_HOUR}:00 开新窗口）`,
          at: Date.now(),
        };
        log(`${account.id} 窗口未开，记 pending（调度器会在重试阶梯里再试）`);
      } else if (claimable || doc?.showCampaign === true) {
        // 上游说「有活动」但过滤后一条可领的都没有 —— 那才是真的领过了。这是**正面信号**。
        record = {
          date: today,
          status: 'already',
          message: '今天已领过（上游没有可领项）',
          at: Date.now(),
        };
        log(`${account.id} claimable=${claimable} 但无可领项，记 already`);
      } else {
        // 上游既没给 claimable 也没给活动：**不能当已签**。2026-11-11~14 就是在这里把
        // 「请求没被认」误记成 `already`，四天没真领到。记 error 并标 transient，让面板看得见。
        record = {
          date: today,
          status: 'error',
          message: '上游返回空活动列表（claimable/showCampaign 都是 false）——请求可能未被识别',
          at: Date.now(),
        };
        // 标成可重试：如果是上游抖动/风控，下一档重试可能就恢复了。
        transient = true;
        log(`${account.id} 空活动列表且无 claimable 信号，记 error（不猜成已签）`);
      }
    } else {
      const campaign = campaigns[0];
      const claimDoc = await callApi(account, `${CAMPAIGNS_PATH}/${encodeURIComponent(campaign.campaignId)}/claim`, {
        method: 'POST',
      });
      const replayed = claimDoc && claimDoc.replayed === true;
      const amount =
        (claimDoc && claimDoc.benefit && typeof claimDoc.benefit.amount === 'number' && claimDoc.benefit.amount) ||
        (campaign.benefit && typeof campaign.benefit.amount === 'number' && campaign.benefit.amount) ||
        0;
      record = {
        date: today,
        status: replayed ? 'already' : 'checked',
        credits: amount,
        extraCredits: 0,
        // Qoder 的签到不发「连续天数」，接口里没有这个字段。
        streakDays: null,
        message: replayed ? '今天已经领过' : `签到成功，获得 ${amount} Credits`,
        at: Date.now(),
        outcome: replayed ? 'replayed' : 'claimed',
      };
      log(`${account.id} 签到 ${record.status} campaignKey=${campaign.campaignKey || '?'} amount=${amount} replayed=${replayed}`);
      // 顺手消掉通知红点。失败不影响发放，所以吞掉。
      callApi(account, `/sash/api/v1/me/notifications/${encodeURIComponent(campaign.campaignId)}/read`, {
        method: 'POST',
      }).catch((error) => log(`标记已读失败（不影响发放）：${error.message}`));
    }
  } catch (error: any) {
    record = { date: today, status: 'error', message: error.message, at: Date.now() };
    log(`${account.id} 签到失败：${error.message}`);
  }

  // 失败的一次尝试绝不能抹掉当天早些时候记录的成功：那条是唯一保存已得积分的地方。
  const earlier = keepEarlierSuccess(account, today, record);
  if (earlier) {
    log(`${account.id} 签到 ${record.status}：保留当天已有的成功记录（${earlier.credits} credits）`);
    return { ...earlier, outcome: record.status, transient };
  }

  if (!writeCheckinStore(account, record)) log(`${account.id} 签到状态写入失败`);
  return { ...record, transient };
}

export function readLastCheckin(account: Account): CheckinRecord | null {
  return readCheckinState(account);
}
