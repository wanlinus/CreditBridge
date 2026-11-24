// WorkBuddy 的额度与每日签到。余额和签到是**账号**属性，所有入口都收 `Account`、签到记录按账号存，
// 否则 A 领过了、B 就被判成「今天已签」。签到接口 code 10001 表示「今天已经领过」，等同于成功。

import type { Account, CheckinRecord, Credits } from '../../types.ts';
import { localDate } from '../../shared/clock.ts';
import { usableCredential } from '../../core/accounts.ts';
import { keepEarlierSuccess, readCheckinState, writeCheckinState } from '../../core/checkin-store.ts';
import { refreshWorkBuddyCredential, BILLING_BASE, TIMEOUT_MS } from './auth.ts';

const BILLING_URL = `${BILLING_BASE}/v2/billing/meter/get-user-resource`;
const CHECKIN_URL = `${BILLING_BASE}/v2/billing/meter/daily-checkin`;

let logSink: any = null;
export function setUsageLogger(fn: any) {
  logSink = fn;
}
function log(...args: unknown[]) {
  if (logSink) logSink(`[workbuddy-usage] ${args.join(' ')}`);
}

function billingHeaders(credential: any) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (credential.uid) headers['X-User-Id'] = credential.uid;
  if (credential.enterpriseId) {
    headers['X-Enterprise-Id'] = credential.enterpriseId;
    headers['X-Tenant-Id'] = credential.enterpriseId;
  }
  if (credential.domain) headers['X-Domain'] = credential.domain;
  return headers;
}

/** 解析上游的时间串（形如 `2026-11-15 13:03:41`，没有时区标记，按本地时间理解）。空串或解析不出来返回 null（面板用 null 表示「没有到期时间」）。
 * 空格换 `T` 再交给 `Date.parse`：直接喂在 V8 里能解析，但那属于实现细节，接近 ISO 的写法更稳。 */
function parseUpstreamTime(raw: any): number | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const ms = Date.parse(raw.trim().replace(' ', 'T'));
  return Number.isFinite(ms) ? ms : null;
}

export async function getCredits(account: Account): Promise<Credits> {
  const credential = await usableCredential(account, refreshWorkBuddyCredential);
  const now = new Date();
  const fmt = (date: any) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
  const response = await fetch(BILLING_URL, {
    method: 'POST',
    headers: billingHeaders(credential),
    body: JSON.stringify({
      PageNumber: 1,
      PageSize: 100,
      ProductCode: 'p_tcaca',
      Status: [0, 3],
      PackageEndTimeRangeBegin: fmt(now),
      PackageEndTimeRangeEnd: fmt(new Date(now.getTime() + 3185136000)),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(`WorkBuddy 余额接口返回非 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`);
  }
  // **必须检查状态码和业务码**。原先直接 `response.json()` 再 `doc?.data?...|| []`：上游 5xx 时
  // packages 变成空数组、`totalRemain` 算出 **0**，而 0 是合法数字，`core/credits.ts` 会当成
  // 「读到了，剩余 0」缓存 30 秒——徽标显示「剩余 0」看起来像额度用光，实际只是上游抖了一下。
  if (!response.ok) throw new Error(`WorkBuddy 余额接口 HTTP ${response.status}：${text.slice(0, 200)}`);
  if (doc && typeof doc.code === 'number' && doc.code !== 0) {
    throw new Error(`WorkBuddy 余额接口 code ${doc.code}：${String(doc.msg || text).slice(0, 200)}`);
  }
  const packages = doc?.data?.Response?.Data?.Accounts || [];
  // 归一成 UsagePackage（`name` / `limit` / `used` / `expireAt`）。上游字段名完全不同
  // （PackageName / CapacitySize / CapacityRemain / ExpiredTime / CycleEndTime），
  // 原样透传会让面板那张「积分包」表整行渲染成 `undefined / — / 0 / —`。
  const items = packages.map((item: any) => {
    const limit = Number(item.CapacitySize) || 0;
    const remain = Number(item.CapacityRemain) || 0;
    return {
      name: typeof item.PackageName === 'string' && item.PackageName ? item.PackageName : '积分包',
      limit,
      used: Math.max(0, limit - remain),
      // 过期优先用 ExpiredTime；它为空串时退回周期结束时间（周期包还没过期）。
      expireAt: parseUpstreamTime(item.ExpiredTime) ?? parseUpstreamTime(item.CycleEndTime),
    };
  });
  return {
    provider: account.channelId,
    supported: true,
    // 剩余量从 accounts 直接算：packages 里只剩 limit/used，remain 是派生值。
    totalRemain: packages.reduce((sum: number, item: any) => sum + (Number(item.CapacityRemain) || 0), 0),
    packages: items,
    account: {
      uid: credential.uid,
      username: credential.username || '',
      domain: credential.domain,
      tokenExpiresAt: new Date(credential.expiresAt).toISOString(),
      source: credential.source,
    },
  };
}

// 本地签到状态的读写统一在 `core/checkin-store.ts`（和上游协议无关）。

/** 领今天的签到奖励。幂等：当天已领过时上游回 10001、记成 `already`，同一个本机日历日内不再重试。
 * 返回的 `outcome` 用来区分「这次真领到了」和「今天早些时候已经领过」——直接回存好的记录会让调用方以为刚刚又签了一次。 */
export async function claimCheckin(account: Account): Promise<CheckinRecord> {
  const today = localDate();
  let state: CheckinRecord;
  try {
    const credential = await usableCredential(account, refreshWorkBuddyCredential);
    const response = await fetch(CHECKIN_URL, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: '{}',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      doc = { code: -1, msg: text.slice(0, 300) };
    }
    if (doc.code === 0) {
      state = {
        date: today,
        status: 'checked',
        // 上游字段是单数 `credit`，落盘统一成 `credits`。缺失时留 null，不编一个数字。
        credits: typeof doc.data?.credit === 'number' ? doc.data.credit : null,
        streakDays: typeof doc.data?.streak_days === 'number' ? doc.data.streak_days : null,
        message: doc.msg || '签到成功',
        at: Date.now(),
      };
      log(`${account.id} checkin success credits=${state.credits} streak=${state.streakDays}`);
    } else if (doc.code === 10001) {
      state = { date: today, status: 'already', message: doc.msg || '今天已签到', at: Date.now() };
      log(`${account.id} checkin skipped: already checked in today`);
    } else {
      state = { date: today, status: 'error', code: doc.code, message: doc.msg || text.slice(0, 200), at: Date.now() };
      log(`${account.id} checkin failed code=${doc.code} msg=${state.message}`);
    }
  } catch (error: any) {
    state = { date: today, status: 'error', message: error.message, at: Date.now() };
    log(`${account.id} checkin error: ${error.message}`);
  }

  // 失败的一次尝试绝不能抹掉当天早些时候记录的成功：那条记录是唯一保存已得积分和连续天数的地方。
  const earlier = keepEarlierSuccess(account, today, state);
  if (earlier) {
    log(`${account.id} checkin ${state.status}: keeping today's successful record (${earlier.credits} credits)`);
    return { ...earlier, outcome: state.status };
  }

  writeCheckinState(account, state);
  return { ...state, outcome: state.status };
}

export function readLastCheckin(account: Account): CheckinRecord | null {
  return readCheckinState(account);
}
