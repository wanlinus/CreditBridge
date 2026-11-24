// Loomy 额度（积分余额）。
//
// 余额接口是 `GET /api/v1/points/records?pageNo=1&pageSize=1&recordType=all`，
// 响应里 `data.balance` + `data.dailyBalance` 才是可用积分。这个形状是从前端 bundle
// 还原的（`main-Bv7VZXLM.js` 读 `d?.data?.data` 的 `balance` / `dailyBalance`；那个 `d`
// 是 axios 响应，换成 fetch 就是 `doc.data`），不是公开文档。
//
// **`balance` 单独一个不是「可用积分」**：它是长期池，当日赠送池另记在 `dailyBalance`，
// 两个加起来才是能用的。2026-11-12 实测 lo-1：`balance=5500`、`dailyBalance=3595`、
// `availableBalance=9095`，流水里的 `balanceBefore/After` 也在 9095 量级——只有 v1 会
// 回 `availableBalance`，v2 不回，但两边 `balance` / `dailyBalance` 一致。
// 只取 `balance` 会让徽标和面板少显示四成，而且**不会报任何错**。
//
// 没有「套餐包 / 到期时间」概念——积分就是一个余额数字，随对话扣减。所以 `packages`
// 只给一行「可用积分」，`totalRemain` 就是那个合计数。
//
// **每日积分是有的，但不叫「签到」**：Loomy 的每日收益挂在「宠物打工」
// （`GET /api/v1/pet-work` + `POST /api/v1/pet-work/rewards`）上，按当天有效对话轮次
// 算分、跨档位才发奖，每日封顶 `dailyMaxPoints`（实测 1000）。它不是「点一下领固定分」，
// 所以网关没有实现 `checkinStatusOf` / `checkinClaimOf`（见 private/docs/loomy-recon.md §5）。

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

/** 拉一次余额。 */
export async function getLoomyCredits(account: Account): Promise<Credits> {
  const credential = await usableCredential(account, refreshLoomyCredential);
  // `pageSize` 从 1 提到 100：这个接口本来就同时回余额和流水，一次请求把「今日已用」
  // 也算出来，不必再单独打一次上游（见下面 `usedToday`）。
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

  // 形状是 `{ code, desc, data: { balance, dailyBalance, availableBalance, list } }`。
  // 少读一层会拿到 undefined（`Number(undefined)` 是 NaN），余额接口就永远报错。
  //
  // 但这里**同时认扁平形状**：上游换个封装层我们没法预知，而余额读不到会让整个
  // 徽标和面板都显示「—」——比多写一个 `??` 的维护成本高得多。
  const payload = doc?.data && typeof doc.data === 'object' ? doc.data : {};
  const node = payload.data && typeof payload.data === 'object' ? payload.data : payload;

  // 三层回退取「可用积分」：服务端算好的 `availableBalance` → `balance + dailyBalance`
  // → `balance`。理由见文件头：`balance` 只是长期池，单独用它少显示四成。
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
   * 「今日已用」：把今天从**当日池**扣掉的分数加起来。
   *
   * 为什么是「今日」而不是「累计」：Loomy 的当日池**每天 0 点重置为 5000**（实测，
   * 见 private/docs/loomy-recon.md §4c），「累计已用」这个概念对它不成立——昨天用掉的分数
   * 今天不会体现在任何数字里。说「今日已用 2169」是准确的，说「累计已用」是错的。
   *
   * 判据用 `dailyCycleDate`（只有当日池的流水带这个字段）而不是 `direction`：
   * 长期池的扣分记录没有它，正好被排除掉。
   *
   * **局限**：只统计这一页（100 条）。一天从当日池扣超过 100 次的极端情况下会少算，
   * 那时界面上的数字偏小。相对于「再翻几页」的开销，这个折中值得；真要精确就得按
   * `pageNo` 一直翻到 `dailyCycleDate` 不是今天为止。
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
     * **Loomy 没有「总额度」这个概念，所以这里不硬造一个。**
     *
     * 硬凑 `limit = 剩余 + 今日已用`（好让 `limit - used = 剩余` 和另三家一致）只在
     * 「当日池刚重置」时成立：一旦用完（剩余 0），算出来 `limit = 0 + 1011 = 1011`，
     * 看着像「总共给 1011、用完了」——真相是「今天给过 5000、用掉 1011、还剩 0」。
     * **编一个看起来自洽的数字，比不给这个数字更糟。**
     *
     * 所以 `limit` 留 `null`（界面显示 `—`），只给 `used`（今日已用）和 `totalRemain`。
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
