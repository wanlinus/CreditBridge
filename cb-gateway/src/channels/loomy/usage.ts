// Loomy 额度（积分余额）。余额接口 `GET /api/v1/points/records?pageNo=1&pageSize=1&recordType=all`，
// 可用积分是 `data.balance` + `data.dailyBalance` 两个池之和——**只取 `balance` 会让徽标少显示四成
// 而且不报任何错**（实测 balance=5500、dailyBalance=3595、availableBalance=9095）。
// 没有套餐/到期概念；每日收益挂在「宠物打工」上、按对话轮次发奖，所以本通道没有签到。

import type { Account, Credits } from '../../types.ts';
import { usableCredential } from '../../core/accounts.ts';
import { localDate } from '../../shared/clock.ts';
import { POINTS_BASE, TIMEOUT_MS, loomyApiHeaders, refreshLoomyCredential } from './auth.ts';

const RECORDS_PATH = '/api/v1/points/records';

let logSink: any = null;
export function setUsageLogger(fn: any) {
  logSink = fn;
}
function log(...args: unknown[]) {
  if (logSink) logSink(`[loomy-usage] ${args.join(' ')}`);
}

/** 拉一次余额。 */
export async function getCredits(account: Account): Promise<Credits> {
  const credential = await usableCredential(account, refreshLoomyCredential);
  // `pageSize` 从 1 提到 100：这个接口同时回余额和流水，一次请求把「今日已用」也算出来。
  const url = `${POINTS_BASE}${RECORDS_PATH}?pageNo=1&pageSize=100&recordType=all`;
  const response = await fetch(url, {
    headers: loomyApiHeaders(credential.session),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(`Loomy 余额接口返回非 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`);
  }
  if (!response.ok) throw new Error(`Loomy 余额接口 HTTP ${response.status}：${doc?.desc || text.slice(0, 200)}`);

  // 形状是 `{ code, desc, data: { balance, dailyBalance, availableBalance, list } }`。少读一层会拿到
  // undefined（`Number(undefined)` 是 NaN），余额接口就永远报错。但也**同时认扁平形状**：
  // 上游换个封装层我们没法预知，而余额读不到会让整个徽标显示「—」，比多一个 `??` 贵得多。
  const payload = doc?.data && typeof doc.data === 'object' ? doc.data : {};
  const node = payload.data && typeof payload.data === 'object' ? payload.data : payload;

  // 三层回退取「可用积分」：`availableBalance` → `balance + dailyBalance` → `balance`。
  // `balance` 只是长期池，单独用它少显示四成（见文件头）。
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

  /*
   * 「今日已用」：把今天从**当日池**扣掉的分数加起来。Loomy 的当日池每天 0 点重置为 5000，
   * 所以「累计已用」这个概念对它不成立。判据用 `dailyCycleDate`（只有当日池的流水带它）而不是
   * `direction`，长期池的扣分记录正好被排除。
   * **局限**：只统计这一页（100 条），一天扣超过 100 次的极端情况会少算。
   */
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
    /*
     * **Loomy 没有「总额度」这个概念，所以不硬造一个。** 硬凑 `limit = 剩余 + 今日已用`
     * 只在「当日池刚重置」时成立：一旦用完（剩余 0），算出来 `limit = 0 + 1011 = 1011`，
     * 看着像「总共给 1011、用完了」，真相是「今天给过 5000、用掉 1011、还剩 0」。
     * 所以 `limit` 留 `null`（界面显示 `—`），只给 `used` 和 `totalRemain`。
     */
    packages: [
      {
        name: '今日积分',
        // 显式给 `null` 而不是省略：省略会让类型检查以为漏了字段。
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
