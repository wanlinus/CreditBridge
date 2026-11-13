import type { Account, CheckinRecord, Credits } from '../../types.ts';
import { localDate } from '../../shared/clock.ts';
import { usableCredential } from '../../core/accounts.ts';
import { keepEarlierSuccess, readCheckinState, writeCheckinState } from '../../core/checkin-store.ts';
import { refreshWorkBuddyCredential } from './auth.ts';

const BILLING_BASE = 'https://www.codebuddy.cn';
const BILLING_URL = `${BILLING_BASE}/v2/billing/meter/get-user-resource`;
const CHECKIN_URL = `${BILLING_BASE}/v2/billing/meter/daily-checkin`;

let logSink: any = null;
export function setWorkBuddyUsageLogger(fn: any) {
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

function parseUpstreamTime(raw: any): number | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const ms = Date.parse(raw.trim().replace(' ', 'T'));
  return Number.isFinite(ms) ? ms : null;
}

export async function getWorkBuddyUsage(account: Account): Promise<Credits> {
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
    signal: AbortSignal.timeout(30000),
  });
  const doc: any = await response.json();
  const packages = doc?.data?.Response?.Data?.Accounts || [];
  const items = packages.map((item: any) => {
    const limit = Number(item.CapacitySize) || 0;
    const remain = Number(item.CapacityRemain) || 0;
    return {
      name: typeof item.PackageName === 'string' && item.PackageName ? item.PackageName : '积分包',
      limit,
      used: Math.max(0, limit - remain),
      expireAt: parseUpstreamTime(item.ExpiredTime) ?? parseUpstreamTime(item.CycleEndTime),
    };
  });
  return {
    provider: account.channelId,
    supported: true,
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

export async function claimCheckin(account: Account): Promise<CheckinRecord> {
  const today = localDate();
  let state: CheckinRecord;
  try {
    const credential = await usableCredential(account, refreshWorkBuddyCredential);
    const response = await fetch(CHECKIN_URL, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: '{}',
      signal: AbortSignal.timeout(30000),
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
