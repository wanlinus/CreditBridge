// `GET /api/accounts/<id>/credits` 的响应体：余额 + 今日签到 + 「该显示哪个认证按钮」。
//
// 按**账号**取：同一通道不同账号的余额本来就是分开的。信封形状保持 v1 的样子
// （插件面板、徽标都在读），新增字段只加不改。

import type { Account, Channel, CheckinRecord, UsagePackage } from '../types.ts';
import { channelById } from '../channels/index.ts';
import { usageAccountTokens } from '../store/usage.ts';

/**
 * 余额缓存 30 秒。
 *
 * 徽标每 60 秒拉一次，概览页和账号页又各拉一遍，同一个号一分钟被打三四次上游而余额
 * 不会秒级变化。30 秒是「挡住密集轮询、又不至于让手动刷新看不出变化」的折中——
 * 签完到用户会立刻刷新看变化，缓存太长会让人以为签到没生效。
 *
 * **失败不进缓存**：否则一个只需重登的号会在 30 秒里一直显示「—」。
 */

const CREDITS_TTL_MS = 30_000;

/**
 * 一个账号的余额快照。
 *
 * `remain` / `used` / `limit` 都是**官方口径**，来自通道自己的 `creditsOf()`：
 * 上游给什么就是什么，网关不推算。`used` 为 `null` 表示**该通道不提供**这个数——
 * 那和「确实用了 0」不是一回事，界面上要显示 `—` 而不是 `0`。
 */
export interface CreditSnapshot {
  remain: number | null;
  used: number | null;
  limit: number | null;
  /**
   * 上一次**真实读取**上游时的剩余值，用来显示「较上次 ±X」。
   *
   * **它是两条余额快照之间的差，不是逐请求结算出来的消耗。** 余额本来就隔一段时间才刷新
   * 一次，两者口径一致；网关不再为「用了多少积分」做任何逐请求推算（那正是这套设计要拆掉的
   * 东西，见 private/docs/v3/overview-redesign.md）。它只回答「从上次看到现在掉了多少」。
   */
  prevRemain: number | null;
  /** 上一次真实读取的时间（毫秒），没有上一次就是 `null`。 */
  prevAt: number | null;
  /** 本次快照的时间：缓存命中时是那次真实读取的时间，不是请求时间。 */
  at: number;
}

/**
 * 一次**真实读取**的结果：快照 + 失败原因。
 *
 * 列表接口只用 `snapshot`（读不到就显示「—」）；手动刷新要 `error`——用户点了按钮，
 * 就必须能知道「为什么数字没变」，否则又是一个静默失败。
 */
export interface CreditRead {
  snapshot: CreditSnapshot;
  error: string | null;
}

const creditsCache = new Map<string, CreditSnapshot>();

/** 把上游的 `packages` 累加成「总额度 / 已用」。 */
function sumPackages(packages: any): { used: number | null; limit: number | null } {
  const list = Array.isArray(packages) ? packages : [];
  if (list.length === 0) return { used: null, limit: null };
  const everyNumber = (key: string) => list.every((item: any) => typeof item?.[key] === 'number');
  // 每一项都得有数字才算得出来。`limit` 允许是 `null`（Loomy 没有「总额度」这个概念）——
  // 这时如实返回 `null`，界面上显示 `—`，不要用 `used` 去凑。
  return {
    used: everyNumber('used') ? list.reduce((sum: number, item: any) => sum + item.used, 0) : null,
    limit: everyNumber('limit') ? list.reduce((sum: number, item: any) => sum + item.limit, 0) : null,
  };
}

/**
 * 并发拉一批账号的余额，**失败的记 `null` 而不是抛**。
 *
 * 为什么值得单独抽出来：概览页、账号列表页、导航条的数字都要它，而它们的容错策略必须
 * 一致——一个号的凭据坏了不能让整页 500，页面上显示「—」就够了，原因在账号详情页里
 * 有更明确的提示。
 */
export async function creditsByAccount(accounts: Account[]): Promise<Record<string, CreditSnapshot>> {
  const out: Record<string, CreditSnapshot> = {};
  const now = Date.now();
  await Promise.all(
    accounts.map(async (account) => {
      // 直接按 id 查缓存；已删账号的残留缓存在函数末尾统一清掉（见下方清理段）。
      const cached = creditsCache.get(account.id);
      if (cached && now - cached.at < CREDITS_TTL_MS) {
        out[account.id] = cached;
        return;
      }
      out[account.id] = (await readOne(account, cached, now)).snapshot;
    }),
  );
  // 顺手清掉已经不在册的账号，避免删号后缓存一直留着（量很小，但会慢慢涨）。
  if (creditsCache.size > accounts.length) {
    const alive = new Set(accounts.map((account) => account.id));
    for (const id of creditsCache.keys()) if (!alive.has(id)) creditsCache.delete(id);
  }
  return out;
}

/**
 * 真去上游读一个账号的余额，并顺手更新缓存。
 *
 * `creditsByAccount()`（读列表，带 30 秒缓存）和 `refreshCredits()`（用户手动点「刷新」，
 * 必须绕过缓存）走的是**同一条路径**——各写一份的话，某天改了口径只改一处，另一边就
 * 静默给出不一样的数。
 *
 * **失败不抛**：返回 `remain: null` 加一句原因。列表场景只要前者（界面显示「—」），
 * 手动刷新场景要后者（用户点了按钮，就得知道为什么数字没变）。
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
      // 上一次的值往后挪一格：这次读到的成为「当前」，上一次的成为「较上次」的基准。
      prevRemain: cached?.remain ?? null,
      prevAt: cached?.at ?? null,
      at: now,
    };
    // 只有真取到数字才缓存；`null` 可能是凭据坏了，不该挡住重试。
    if (remain !== null) creditsCache.set(account.id, snapshot);
    return { snapshot, error: remain === null ? '上游没有返回剩余额度' : null };
  } catch (error: any) {
    // 凭据坏了、上游挂了：页面上显示「—」，比整页 500 好。
    return empty(error && error.message ? String(error.message) : String(error));
  }
}

/**
 * 用户手动「刷新积分」：**绕过 30 秒缓存**直接问上游，并把「为什么没读到」带回去。
 *
 * 为什么必须绕过：那个 TTL 是为了挡住密集轮询，手动点按钮的语义恰恰是「我不信缓存，
 * 现在就去问」。绕过却不清缓存的话，下一次列表拉取又会把旧值盖回来，看起来像刷新没生效。
 *
 * 注意语义：这次读到的值会成为下一次「较上次 ±X」的基准，`readOne()` 里已经处理。
 */
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

/**
 * 前端该显示哪些认证按钮。
 *
 * 两个布尔都是**通道自述的能力**（有没有实现 `login` / `logoutOf`），不是账号
 * 状态，也不互斥——WorkBuddy 同时实现了两者，两个按钮会一起出现。账号一定存在
 * （不然拿不到这里），所以 `loggedIn` 恒为 `true`。
 */
function authFlags(channel: Channel) {
  return {
    loggedIn: true,
    canLogin: typeof channel.login === 'function',
    canLogout: typeof channel.logoutOf === 'function',
  };
}

/** 网关这边的账号身份，和上游返回的账号信息合并后一起回给前端。 */
function accountMeta(account: Account) {
  return {
    id: account.id,
    label: account.label,
    status: account.status,
    statusMessage: account.statusMessage,
    cooldownUntil: account.cooldownUntil,
  };
}

/**
 * 账号列表的**唯一组装处**：余额快照 + 今日/累计 token。
 *
 * 概览页、账号页、`GET /api/accounts` 三处都要这批数字，原先各写一遍；只要有一份忘了
 * `?? 0` 或键名拼错，某个页面的「今日」一列就全是 0，而账本里明明有数。
 *
 * 余额要打上游、账本要读库，互不依赖所以并发取——串行就是白等。
 *
 * 给 token 而不是积分：积分在账本里覆盖率只有 58%（上游经常不报单次消耗），
 * token 是网关亲眼看到并记下来的，才能跨通道比较和加总。
 *
 * 只返回两张直查表：调用方只要这两个数字，早先返回整份 `usageSummary()` 对象
 * （14 天三维度分桶、最近 20 条、费用估算）全算完却没人读。
 */
export async function accountsWithSpend(accounts: Account[]): Promise<{
  credits: Record<string, CreditSnapshot>;
  tokensToday: Record<string, number>;
  tokensTotal: Record<string, number>;
}> {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todaySince = startOfToday.getTime();
  // 和 `usageSummary()` 的 `WINDOW_DAYS` 必须一致（30 个本地日历日，含今天）。
  // 两处口径分叉的话，账号列表页的「近 30 天」和概览页的同一个数字会对不上，
  // 而两个数都不会报错。`test:store-usage` 钉住了归一规则，这条常量由人工对齐。
  const windowSince = todaySince - 29 * 86400000;

  // 余额要打上游（每个号一个 HTTP），账本要读库。两者互不依赖，串行就是白等。
  const [credits, tokensTotal, tokensToday] = await Promise.all([
    creditsByAccount(accounts),
    Promise.resolve(usageAccountTokens({}, windowSince)),
    Promise.resolve(usageAccountTokens({}, todaySince)),
  ]);
  return { credits, tokensToday, tokensTotal };
}

/**
 * `buildCredits()` 的返回体。
 *
 * **两种形态必须显式写出来**：成功时是完整的余额快照；失败时是
 * `{supported:false, error}`，**没有 `totalRemain`**。早先靠 TypeScript 从两个
 * return 分支推断，得到一个 union，调用方要么访问不到 `error`、要么以为
 * `totalRemain` 一定存在——类型检查在读取处才报错，而不是在组装处。
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
  /** 通道自己的显示名（徽标和面板标题用，前端不内置对照表）。 */
  label: string;
  /** 通道短前缀（`wb`）。 */
  idPrefix: string;
  /** 今天的本地签到记录；没有就是 null。 */
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
      // 上游账号信息（uid / 昵称 / token 到期）和网关这边的身份合成一段。
      account: { ...(credits.account || {}), ...accountMeta(account) },
      ...meta,
    };
  } catch (error: any) {
    // 凭据失效时恰恰最需要「重新登录」按钮，失败分支也要带上认证状态。
    return {
      supported: false,
      provider: channel.id,
      error: error.message,
      account: accountMeta(account),
      ...meta,
    };
  }
}
