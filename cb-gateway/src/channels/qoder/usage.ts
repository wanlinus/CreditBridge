// Qoder 的额度与每日签到。全部接口都在 `openapi.qoder.com.cn`。
//
//   GET  /sash/api/v2/me/usage                     额度和用量
//   GET  /sash/api/v1/me/campaigns                 当轮可领活动
//   POST /sash/api/v1/me/campaigns/<id>/claim      领取
//   POST /sash/api/v1/me/notifications/<id>/read   标记已读（可选）
//
// `gateway.qoder.com.cn` 对 `/sash/*` 的响应与它逐字节相同，但官方 CLI 用的是
// `openapi`，所以跟着官方走（见 `private/docs/qoder-linux-recon.md` §3/§7）。
//
// **签到是「活动」不是「签到」**：产品内部叫 campaign，所以猜路径找不到
// （`/me/checkin`、`/me/streak` 全 404），这组接口是靠 MITM 抓真实流量解出来的。
//
// **campaignId 每轮都换**，所以必须现查现领，不能缓存上一轮的 ID。

import type { Account, CheckinRecord, CheckinStatus, Credits } from '../../types.ts';
import { usableCredential } from '../../core/accounts.ts';
import { keepEarlierSuccess, readCheckinState, writeCheckinState as writeCheckinStore } from '../../core/checkin-store.ts';
import { refreshQoderCredential, type QoderCredential } from './auth.ts';

const BASE = 'https://openapi.qoder.com.cn';
const USAGE_PATH = '/sash/api/v2/me/usage';
const CAMPAIGNS_PATH = '/sash/api/v1/me/campaigns';
/**
 * 签到活动每天北京时间 **10:00** 开一个新窗口，到次日 09:59 截止。
 *
 * **这一点直接决定了全局签到时间**：`config.checkinTime` 默认定在 10:05 就是为了它。
 * 定在窗口开启之前去领会拿到空 `campaigns`，然后被记成「没有可领的活动」——
 * 一次都没真领到，而面板上一片正常。
 */
const CHINA_OFFSET_MINUTES = 8 * 60;
/** 活动窗口每天 10:00（北京时间）开启。 */
const WINDOW_OPEN_HOUR = 10;

let logSink: any = null;
export function setQoderUsageLogger(fn: any) {
  logSink = fn;
}
function log(...args: unknown[]) {
  if (logSink) logSink(`[qoder-usage] ${args.join(' ')}`);
}

function authHeaders(credential: QoderCredential): Record<string, string> {
  // 和官方 CLI 一致：/sash 接口只带 Accept + Authorization，**不带** User-Agent，
  // 也不带 Content-Type（GET 不该带；claim 的 POST 空 body 也不需要）。
  return {
    Authorization: `Bearer ${credential.token}`,
    Accept: 'application/json',
    // ---------------------------------------------------------------- 必须带这个
    //
    // 少了 `cosy-clienttype`，上游对 `/sash/api/v1/me/campaigns` 会**静默返回空**：
    //
    //   {"showCampaign":false,"claimable":false,"campaigns":[]}
    //
    // 那个形状和「今天已领完」逐字节相同，所以缺了它会把每次签到都记成 `already`，
    // **一次都没真领过**，而界面上一切正常（2026-11-11 上线后四天就是这么坏的）。
    //
    // 逐字段二分的结果（`private/docs/qoder-recon.md` §9）：
    //   cosy-clienttype: 10   ← **必需且充分**，其它 cosy-* 全去掉也能拿到数据
    //   cosy-clienttype: 1/99 ← 不行，值必须是 10（客户端类型，不是版本）
    //   cosy-version          ← 可有可无
    //
    // 值写死 10。**不要**去读客户端文件、也不要拷用户的机器号：网关跑在别的机器上，
    // 那套假设一站不住就是静默失败。
    'cosy-clienttype': '10',
  };
}

/** 发一个带鉴权的请求；401 时强制续期一次再试。 */
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

// ---------------------------------------------------------------- 额度

/**
 * 额度快照。
 *
 * **`userQuota` 和 `addOnQuota` 不能相加**：前者是套餐额度，后者是加购/活动额度
 * （每日签到就进这里），两者语义和过期时间都不同。`totalRemain` 给徽标用，
 * 两块的明细放 `packages`。
 */
export async function getQoderCredits(account: Account): Promise<Credits> {
  const credential = await usableCredential(account, refreshQoderCredential);
  const doc = await callApi(account, USAGE_PATH);
  const usage = doc && doc.qoderUsage ? doc.qoderUsage : {};
  const userQuota = usage.userQuota || {};
  const addOnQuota = usage.addOnQuota || {};

  // 归一成 UsagePackage（`name` / `limit` / `used` / `expireAt`），和另两个通道一致。
  // 透传上游字段名会让面板那张「积分包」表整行渲染成 `undefined / — / 0 / —`。
  const toPackage = (name: string, quota: any) => ({
    name,
    limit: Number(quota.total) || 0,
    used: Number(quota.used) || 0,
    // Qoder 的额度是周期重置，没有「到期时间」这个概念。
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
    // 徽标只认这一个数字，所以取两块剩余之和——这是用户真正还能用的量。
    // 归一成 limit/used 之后剩余是派生值（limit - used），直接算即可。
    totalRemain: packages.reduce((sum, item) => sum + Math.max(0, item.limit - item.used), 0),
    packages,
    account: {
      uid: credential.userId,
      username: credential.username || '',
      domain: 'qoder.com.cn',
      tokenExpiresAt: credential.expiresAt || null,
      source: credential.source,
    },
    // 面板能直接看出套餐类型和是否超额，不用再点进来。
    userType: usage.userType,
    isQuotaExceeded: usage.isQuotaExceeded === true,
    planExpiresAt: usage.expiresAt,
  } as Credits;
}

// ---------------------------------------------------------------- 签到

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
 * 列出当轮还没领的活动。
 *
 * `campaigns` 里可能混有已完成的历史项，所以按 `claimStatus === 'CLAIMABLE'`
 * 和 `actionType === 'CLAIM_BENEFIT'` 过滤，而不是「取第一个」。
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

/**
 * 上游签到状态。
 *
 * **只能推断，拿不到历史**：领完之后 `campaigns` 里那条会变成 `CLAIMED`，接口不返回
 * 「今天领过什么、领了多少」。所以判据是 `claimable` + 有没有 `CLAIMABLE` 的项。
 *
 * ⚠️ **`campaigns: []` 不等于「已签到」。** 请求头不对（少了 `cosy-clienttype`）时上游
 * 会**静默返回空**，和「今天领完了」长得一模一样——2026-11-11 ~ 11-14 就是这么把一个
 * 完全没签到的号连续四天记成 `already`。所以这里只用 `claimable === true` 作为
 * 「还有东西可领」的正面信号；`claimable !== true` 且列表为空时返回 `checkedIn: false`，
 * 让调用方去走 `pending` / 未知分支，而不是替上游下「已签」的结论。
 */
export async function getCheckinStatus(account: Account): Promise<CheckinStatus> {
  const doc = await callApi(account, CAMPAIGNS_PATH);
  const campaigns = pickCampaigns(doc);
  /**
   * 「还有可领项」的判据要**只看正面信号**。
   *
   * `campaigns: []` 是最容易误判的形状：请求头不对（少 `cosy-clienttype`）时上游
   * 静默回空，和「今天领完了」逐字节相同。所以这里宁可贵一点：只有当上游明确说
   * `claimable: true`、或列表里真有一条可领的，才算「没签」；否则按**未签**处理，
   * 让 `claimCheckin()` 去记 error/pending，而不是替上游宣布「已签」。
   */
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

/**
 * 本机日历日，用来让签到幂等。
 *
 * 用**北京时间**而不是本机时区：活动窗口是按北京时间 10:00 切的，用本机时区
 * 会在跨时区时和上游对不上。这台机器就在东八区，但写死更稳。
 */
function checkinDate(): string {
  const now = new Date();
  const shifted = new Date(now.getTime() + (CHINA_OFFSET_MINUTES + now.getTimezoneOffset()) * 60 * 1000);
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, '0')}-${String(shifted.getDate()).padStart(2, '0')}`;
}

/**
 * 现在是不是**在今天的窗口开启之前**——即：今天这一轮还没开始过。
 *
 * 窗口形状（官方：每天 10:00 开新窗口，到次日 09:59 截止）：
 *
 * ```
 * 11-13 00:00 ────────── 10:00 开窗口 ──────── 11-14 09:59 截止
 *        ↑ 属于「11-12 那一轮」的尾巴              ↑ 之后等 11-14 10:00
 * ```
 *
 * ## 为什么需要这个判断
 *
 * 上游在两种完全不同的情况下都会返回 `campaigns: []`：
 *   1. **今天已经领过了** → 正常，记 `already`
 *   2. **今天这一轮还没开始**（10:00 前）→ 什么也没发生，不该记成「已领」
 *
 * 混为一谈的后果：`already` 同时表示「今天已领」和「今天还没开始」，面板上一切正常，
 * 实际一分没领到。所以窗口没开时返回 `pending`——调度器的 `settledForToday()` 不把
 * `pending` 当成「今天已有结论」，会把它收进重试阶梯，正好覆盖 10:00 之后的窗口。
 *
 * 判据就是「今天 10:00 到了没」。凌晨 00:30 属于昨天那一轮的尾巴，此时
 * `campaigns` 为空说明昨天那轮已领完、今天这轮确实还没开，所以 `小时 < 10` 是对的。
 *
 * ## 为什么带 `at` 参数
 *
 * 这个分支一天只有 10:00 之前那一段才会走到，用真实时钟没法测。参数化之后
 * 改这段要真机验证一次跨天边界。
 */
export function isBeforeCheckinWindow(at: number = Date.now()): boolean {
  const now = new Date(at);
  const shifted = new Date(now.getTime() + (CHINA_OFFSET_MINUTES + now.getTimezoneOffset()) * 60 * 1000);
  return shifted.getHours() < WINDOW_OPEN_HOUR;
}

// 本地签到状态的读写统一在 `core/checkin-store.ts`。

/**
 * 领今天的签到奖励。
 *
 * 两步：先列活动拿 `campaignId`，再 POST 领取。**不能盲发 POST**——没有可领项时
 * 上游回 400 `FIELD_VALIDATION_FAILED`，那不是「今天已签」而是「参数不对」，
 * 混在一起会让面板显示成错误。
 *
 * 幂等：上游对同一 `campaignId` 重复 POST 返回 `replayed: true` 且不重复发放，
 * 所以重试是安全的；这里再叠一层本地记录，同一天不重复请求。
 */
export async function claimCheckin(account: Account): Promise<CheckinRecord> {
  const today = checkinDate();
  const previous = readCheckinState(account);
  if (previous && previous.date === today && previous.status === 'checked') {
    log(`${account.id} 今天已经领过，跳过`);
    return { ...previous, outcome: 'already' };
  }

  let record: CheckinRecord;
  // 默认不可重试；只有「上游回空但我们拿不到 claimable 信号」那种可疑情况才置 true，
  // 让调度器多给几档机会（`test:checkin-scheduler` 钉的是「只有 transient 才走密集阶梯」）。
  let transient = false;
  try {
    // 直接读原始文档而不是 `listClaimableCampaigns()`：这里需要 `claimable` / `showCampaign`
    // 这两个字段来判断「是真空还是请求没被认」。只拿过滤后的数组会丢掉这个信息，
    // 而那正是「空数组被当成已签」那个 bug 的根源。
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
        // 上游说「有活动」但过滤后一条可领的都没有 —— 那才是真的领过了（或者只剩
        // VIEW_DETAILS 那种领不了的活动）。这是**正面信号**，可以下结论。
        record = {
          date: today,
          status: 'already',
          message: '今天已领过（上游没有可领项）',
          at: Date.now(),
        };
        log(`${account.id} claimable=${claimable} 但无可领项，记 already`);
      } else {
        // 上游既没给 claimable 也没给活动：**不能当已签**。
        // 2026-11-11 ~ 11-14 就是在这里把「请求没被认」误记成 `already`，四天没真领到。
        // 记成 error 并标 transient，调度器会重试；面板上也看得见异常。
        record = {
          date: today,
          status: 'error',
          message: '上游返回空活动列表（claimable/showCampaign 都是 false）——请求可能未被识别',
          at: Date.now(),
        };
        // 标成可重试：如果是上游抖动/风控，下一档重试可能就恢复了。
        // 真·请求头有问题时重试也是空，但那会在日志/面板上持续可见，不再静默。
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

  // 失败的一次尝试绝不能抹掉当天早些时候记录的成功：那条是唯一保存
  // 已得积分的地方，网络抖一下不该让界面说今天没签。
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
