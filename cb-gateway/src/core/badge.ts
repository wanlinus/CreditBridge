// 徽标的展示数据。**由网关组装**：显示积分还是 token 是通道语义，
// 放前端的话每加一个计费方式不同的通道都要改插件。
//
// 免费模型上游就报 `credit: 0`（WorkBuddy 的 hy4free），所以积分 0 时要退回显示 token，
// 否则一直显示「今日 0」像是 bug。

import type { Account, Channel } from '../types.ts';
import { buildCredits } from './credits.ts';
import { usageAccountToday } from '../store/usage.ts';

/** `GET /api/accounts/<id>/badge` 的响应体。 */
export interface BadgeView {
  /** 插件用它去 `/api/channels` 的缓存里查图标。 */
  channel: string;
  /** 「Loomy · 示例账号」——悬停提示和图标 alt。 */
  title: string;
  /** 余额；取不到是「—」；通道没有余额接口是「已连接」。 */
  amount: string;
  /** 今日用量文案；没有可说的就是空串。 */
  today: string;
  /** 取不到余额时的原因；正常为 `null`。 */
  note: string | null;
}

/** 100 以上取整，以下保留三位小数（`0.15` 这种小额要看得见）。 */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 100) return String(Math.round(n));
  return String(Math.round(n * 1000) / 1000);
}

/** `192000` → `192K`。 */
function fmtSize(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1_000_000) {
    const millions = n / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/**
 * 组装一个账号的徽标数据。
 *
 * 余额要打上游、账本要读库，两者互不依赖，所以并发取——串行做就是白等一个来回。
 * 账本读失败不该让整个徽标挂掉（余额才是主信息），所以那边单独吞错。
 *
 * ## 为什么不用 `usageSummary()`
 *
 * 这个接口每 60 秒被插件轮询一次，只需要「今天几次、多少 token、多少积分」三个数。
 * 原先它调 `usageSummary({account})`——实测 **4.92ms**，而那里面算的 14 天三维度分桶、
 * 最近 20 条、模型聚合、缓存推算、DeepSeek 折合费用**徽标一个都不读**。
 * 换成一条窄 SQL（`usageAccountToday`）后实测 **0.033ms**，差 150 倍。
 *
 * 口径必须和 `usageSummary().today` 一致：同一个窗口（本地今天 0 点起）、token 都是
 * `prompt + completion`、`credit` 按 0 相加。`test:badge` 钉住这三条。
 */
export async function buildBadge(channel: Channel, account: Account): Promise<BadgeView> {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todaySince = startOfToday.getTime();

  const [credits, today] = await Promise.all([
    buildCredits(channel, account),
    // 读库失败不该让整个徽标挂掉：余额才是主信息，用量只是副行文案。
    (() => {
      try {
        return usageAccountToday(account.id, todaySince);
      } catch {
        return null;
      }
    })(),
  ]);

  // `buildCredits()` 的失败分支会带一个 `error` 字符串（它已经把异常转成了
  // `{supported:false, error}`），成功分支没有这个字段。
  const error = typeof credits.error === 'string' ? credits.error : '';

  let amount: string;
  if (error !== '') {
    // 取不到就显示「—」并把原因带出去，**不编一个 0**——那是假数据。
    amount = '—';
  } else if (!credits.supported) {
    // 通道自述没有余额接口：链路是通的，只是没有数字可报。
    amount = '已连接';
  } else if (typeof credits.totalRemain === 'number') {
    amount = fmt(credits.totalRemain);
  } else {
    amount = '已连接';
  }

  const creditsToday = today && typeof today.credits === 'number' ? today.credits : null;
  const tokensToday = today ? Number(today.tokens) || 0 : 0;
  const requests = today ? Number(today.requests) || 0 : 0;

  let todayText = '';
  if (creditsToday !== null && creditsToday > 0) todayText = `今日 ${fmt(creditsToday)}`;
  else if (tokensToday > 0) todayText = `今日 ${fmtSize(tokensToday)} tok`;
  else if (requests > 0) todayText = `今日 ${requests} 次`;

  return {
    channel: channel.id,
    title: `${channel.label} · ${account.label}`,
    amount,
    today: todayText,
    note: error !== '' ? error : null,
  };
}
