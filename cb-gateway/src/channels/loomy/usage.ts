import type { Account, Credits } from '../../types.ts';
import { usableCredential } from '../../core/accounts.ts';
import { localDate } from '../../shared/clock.ts';
import { LOOMY_POINTS_BASE, loomyApiHeaders, refreshLoomyCredential } from './auth.ts';

const RECORDS_PATH = '/api/v1/points/records';

let logSink: any = null;
export function setLoomyUsageLogger(fn: any) {
  logSink = fn;
}
function log(...args: unknown[]) {
  if (logSink) logSink(`[loomy-usage] ${args.join(' ')}`);
}

export async function getLoomyCredits(account: Account): Promise<Credits> {
  const credential = await usableCredential(account, refreshLoomyCredential);
  const url = `${LOOMY_POINTS_BASE}${RECORDS_PATH}?pageNo=1&pageSize=100&recordType=all`;
  const response = await fetch(url, {
    headers: loomyApiHeaders(credential.session),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(`Loomy 余额接口返回非 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`);
  }
  if (!response.ok) throw new Error(`Loomy 余额接口 HTTP ${response.status}：${doc?.desc || text.slice(0, 200)}`);

  const payload = doc?.data && typeof doc.data === 'object' ? doc.data : {};
  const node = payload.data && typeof payload.data === 'object' ? payload.data : payload;

  const balance = Number(node.balance);
  const dailyBalance = Number(node.dailyBalance);
  const availableBalance = Number(node.availableBalance);
  const usable = Number.isFinite(availableBalance)
    ? availableBalance
    : Number.isFinite(balance) && Number.isFinite(dailyBalance)
      ? balance + dailyBalance
      : balance;
  if (!Number.isFinite(usable)) {
    throw new Error(`Loomy 余额接口没返回有效 balance：${text.slice(0, 200)}`);
  }

  const list = Array.isArray(node.list) ? node.list : [];
  const today = localDate();
  let usedToday = 0;
  for (const item of list) {
    if (!item || item.dailyCycleDate !== today) continue;
    if (item.direction !== 'debit') continue;
    const points = Number(item.pointsActual);
    if (Number.isFinite(points)) usedToday += points;
  }

  log(`${account.id} 可用 ${usable}（长期 ${balance} + 当日 ${dailyBalance}），今日已用 ${usedToday}`);

  return {
    provider: account.channelId,
    supported: true,
    totalRemain: usable,
    packages: [
      {
        name: '今日积分',
        limit: null,
        used: usedToday,
        expireAt: null,
      },
    ],
    account: {
      uid: credential.userId || account.profile?.uid,
      username: account.profile?.username || '',
      domain: 'loomy.xunfei.cn',
      tokenExpiresAt: credential.expiresAt ? new Date(credential.expiresAt).toISOString() : null,
      source: credential.source,
    },
  };
}
