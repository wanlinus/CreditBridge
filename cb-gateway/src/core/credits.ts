// `GET /api/accounts/<id>/credits` 的响应体。信封形状保持 v1 的样子（插件面板、徽标都在读）。

import type { Account, Channel, CheckinRecord, UsagePackage } from '../types.ts';
import { channelById } from '../channels/index.ts';
import { usageAccountTokens } from '../store/usage.ts';
import { beijingMidnight, beijingToday } from '../shared/clock.ts';

/** 挡住密集轮询，又不至于让签到后的手动刷新看不出变化。**失败不进缓存**。 */
const CREDITS_TTL_MS = 30_000;

export interface CreditSnapshot {
  remain: number | null;
  /** `null` 表示**该通道不提供**这个数，和「确实用了 0」不是一回事，界面要显示 `—`。 */
  used: number | null;
  limit: number | null;
  /** 上一次真实读取的剩余值。**是两次快照的差，不是逐请求结算**（见 private/docs/architecture-decisions.md）。 */
  prevRemain: number | null;
  prevAt: number | null;
  /** 缓存命中时是那次真实读取的时间，不是请求时间。 */
  at: number;
}

export interface CreditRead {
  snapshot: CreditSnapshot;
  error: string | null;
}

const creditsCache = new Map<string, CreditSnapshot>();

function sumPackages(packages: any): { used: number | null; limit: number | null } {
  const list = Array.isArray(packages) ? packages : [];
  if (list.length === 0) return { used: null, limit: null };
  const everyNumber = (key: string) => list.every((item: any) => typeof item?.[key] === 'number');
  // `limit` 允许是 `null`（Loomy 没有「总额度」这个概念），如实返回 `null` 显示 `—`，不要用
  // `used` 去凑。
  return {
    used: everyNumber('used') ? list.reduce((sum: number, item: any) => sum + item.used, 0) : null,
    limit: everyNumber('limit') ? list.reduce((sum: number, item: any) => sum + item.limit, 0) : null,
  };
}

/** **失败的记 `null` 而不是抛**：一个号坏了不能让整页 500。 */
export async function creditsByAccount(accounts: Account[]): Promise<Record<string, CreditSnapshot>> {
  const out: Record<string, CreditSnapshot> = {};
  const now = Date.now();
  await Promise.all(
    accounts.map(async (account) => {
      const cached = creditsCache.get(account.id);
      if (cached && now - cached.at < CREDITS_TTL_MS) {
        out[account.id] = cached;
        return;
      }
      out[account.id] = (await readOne(account, cached, now)).snapshot;
    }),
  );
  // 顺手清掉已经不在册的账号。
  if (creditsCache.size > accounts.length) {
    const alive = new Set(accounts.map((account) => account.id));
    for (const id of creditsCache.keys()) if (!alive.has(id)) creditsCache.delete(id);
  }
  return out;
}

/**
 * 列表（带缓存）和手动刷新（绕过缓存）走**同一条路径**——各写一份的话，某天改了口径只改
 * 一处，另一边就静默给出不一样的数。**失败不抛**，返回 `remain: null` 加一句原因。
 */
async function readOne(account: Account, cached: CreditSnapshot | undefined, now: number): Promise<CreditRead> {
  const channel = channelById(account.channelId);
  const empty = (error: string | null): CreditRead => ({
    snapshot: { remain: null, used: null, limit: null, prevRemain: cached?.prevRemain ?? null, prevAt: cached?.at ?? null, at: now },
    error,
  });
  if (!channel) return empty(`没有通道 ${account.channelId}`);
  try {
    const credits = await channel.creditsOf(account);
    const remain = typeof credits.totalRemain === 'number' ? credits.totalRemain : null;
    const { used, limit } = sumPackages((credits as any).packages);
    const snapshot: CreditSnapshot = {
      remain,
      used,
      limit,
      prevRemain: cached?.remain ?? null,
      prevAt: cached?.at ?? null,
      at: now,
    };
    // 只有真取到数字才缓存；`null` 可能是凭据坏了。
    if (remain !== null) creditsCache.set(account.id, snapshot);
    return { snapshot, error: remain === null ? '上游没有返回剩余额度' : null };
  } catch (error: any) {
    // 凭据坏了、上游挂了：页面上显示「—」，比整页 500 好。
    return empty(error && error.message ? String(error.message) : String(error));
  }
}

/** **绕过 30 秒缓存**——那个 TTL 是挡密集轮询的，而手动点按钮的语义是「我不信缓存」。 */
export async function refreshCredits(accounts: Account[]): Promise<Record<string, CreditRead>> {
  const out: Record<string, CreditRead> = {};
  const now = Date.now();
  await Promise.all(
    accounts.map(async (account) => {
      out[account.id] = await readOne(account, creditsCache.get(account.id), now);
    }),
  );
  return out;
}

/** 两个布尔都是**通道自述的能力**，不是账号状态，也不互斥。 */
function authFlags(channel: Channel) {
  return {
    loggedIn: true,
    canLogin: typeof channel.login === 'function',
    canLogout: typeof channel.logoutOf === 'function',
  };
}

function accountMeta(account: Account) {
  return {
    id: account.id,
    label: account.label,
    status: account.status,
    statusMessage: account.statusMessage,
  };
}

/**
 * 账号列表的**唯一组装处**：三处各写一遍的话，只要有一份忘了 `?? 0` 或键名拼错，某个页面的
 * 「今日」一列就全是 0。给 token 而不是积分：积分覆盖率只有 58%。
 */
export async function accountsWithSpend(accounts: Account[]): Promise<{
  credits: Record<string, CreditSnapshot>;
  tokensToday: Record<string, number>;
  tokensTotal: Record<string, number>;
}> {
  // **「今天」按北京时间定**，和 `ledger.ts` / SQL 的 `+8 hours` 同一个口径。
  // 用本地 `setHours(0,0,0,0)` 在 UTC 进程里会偏 8 小时——那是 2026-11-26 在 CI 上
  // 把 `usage-daily` 干红 14 项的原因。现在容器 `TZ=Asia/Shanghai` 碰巧对得上，
  // 但不能靠部署配置兜住代码口径。
  const todaySince = beijingMidnight(beijingToday());
  // 和 `usageSummary()` 的 `WINDOW_DAYS` 必须一致（30 个本地日历日，含今天）。两处口径分叉
  // 的话，账号列表页的「近 30 天」和概览页会对不上，而两个数都不会报错。
  const windowSince = todaySince - 29 * 86400000;

  const [credits, tokensTotal, tokensToday] = await Promise.all([
    creditsByAccount(accounts),
    Promise.resolve(usageAccountTokens({}, windowSince)),
    Promise.resolve(usageAccountTokens({}, todaySince)),
  ]);
  return { credits, tokensToday, tokensTotal };
}

/**
 * **两种形态必须显式写出来**：成功时是完整快照；失败时是 `{supported:false, error}`，没有
 * `totalRemain`。靠 TS 从两个 return 分支推断会得到 union，报错点在读取处而不是组装处。
 */
export interface CreditsView {
  provider: string;
  supported: boolean;
  /** 成功时才有；`error` 存在时没有。 */
  totalRemain?: number;
  packages?: UsagePackage[];
  account?: Record<string, unknown>;
  /** 取余额失败的原因；成功时不存在。 */
  error?: string;
  label: string;
  idPrefix: string;
  checkin: CheckinRecord | null;
  loggedIn: boolean;
  canLogin: boolean;
  canLogout: boolean;
}

export async function buildCredits(channel: Channel, account: Account): Promise<CreditsView> {  // `label` / `idPrefix` 一起回：徽标和面板的标题要用通道自己声明的名字，
  // 前端不该内置一份对照表。
  const meta = {
    label: channel.label,
    idPrefix: channel.idPrefix,
    checkin: channel.lastCheckinOf?.(account) ?? null,
    ...authFlags(channel),
  };
  try {
    const credits = await channel.creditsOf(account);
    return {
      ...credits,
      // 上游账号信息和网关这边的身份合成一段。
      account: { ...(credits.account || {}), ...accountMeta(account) },
      ...meta,
    };
  } catch (error: any) {
    // 凭据失效时最需要「重新登录」按钮，失败分支也要带上认证状态。
    return {
      supported: false,
      provider: channel.id,
      error: error.message,
      account: accountMeta(account),
      ...meta,
    };
  }
}
