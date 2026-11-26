// 用量账本的表（`usage_record`）——**唯一允许出现 SQL 的地方之一**。
//
// 导出的是**语义化函数**而不是泛型 CRUD：名字里带查询意图，调用方就写不出「把 60 万行拉进
// 内存」那种代码。返回的也一律是领域对象（camelCase），列名映射只在本文件做一处。

import { db } from '../shared/db.ts';

/**
 * 账本里没有 `provider` 字段的那些行算谁的。
 *
 * 这是**历史事实**，不是通道清单：`provider` 字段是 2026-11 加的，在那之前的行全是
 * WorkBuddy 的流量。写库和查库都要用它，放两份就会出现「导入用一套、查询用另一套」的
 * 静默不一致。
 */
export const LEGACY_PROVIDER = 'workbuddy';

export interface UsageFilter {
  provider?: string | null;
  account?: string | null;
}

/** 一行账本的领域形状，和 `data/usage.jsonl` 里的字段名**逐字一致**。 */
export interface UsageRecord {
  ts: number;
  provider: string;
  account?: string | null;
  model?: string | null;
  effort?: string | null;
  credit?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  reasoningTokens?: number | null;
  totalTokens?: number | null;
  cachedTokens?: number | null;
  cacheWriteTokens?: number | null;
  durationMs?: number | null;
  status?: number | null;
}

/** 汇总桶。`tokens` 是主口径（prompt + completion），和 `ledger.ts` 的 `emptyTally()` 对齐。 */
export interface UsageTally {
  requests: number;
  credits: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
}

/** 按「天 × 模型 × 账号 × 通道」分组的一格。三个维度在 `ledger.ts` 里再摊开。 */
export interface UsageDailyGroup {
  day: string;
  model: string | null;
  account: string | null;
  provider: string | null;
  requests: number;
  tokens: number;
  completionTokens: number;
  credits: number;
}

export interface UsageGroup {
  key: string;
  requests: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  credits: number;
  /** 上游实测的缓存读取量（`prompt_tokens` 的子集）。不报缓存的通道（Trae）会算出「全部未命中」。 */
  cachedTokens: number;
}

export interface UsageHourGroup {
  /** `00`–`23`，**零填充的字符串**。 */
  hour: string;
  requests: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  credits: number;
}

const num = (value: unknown): number => Number(value) || 0;

/** **只用 `?` 占位**，永远不拼字符串。`until` 是**右开**，否则会把第二天 0 点整的记录算进今天。 */
function whereOf(
  filter: UsageFilter,
  since?: number | null,
  until?: number | null,
): { sql: string; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filter.provider) {
    clauses.push('provider = ?');
    params.push(filter.provider);
  }
  if (filter.account) {
    clauses.push('account = ?');
    params.push(filter.account);
  }
  if (since !== null && since !== undefined) {
    clauses.push('ts >= ?');
    params.push(since);
  }
  if (until !== null && until !== undefined) {
    clauses.push('ts < ?');
    params.push(until);
  }
  return { sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/** 列名映射只有这一处。 */
function rowToRecord(row: any): UsageRecord {
  return {
    ts: num(row.ts),
    provider: String(row.provider ?? LEGACY_PROVIDER),
    account: row.account ?? null,
    model: row.model ?? null,
    effort: row.effort ?? null,
    credit: row.credit ?? null,
    promptTokens: row.prompt_tokens ?? null,
    completionTokens: row.completion_tokens ?? null,
    reasoningTokens: row.reasoning_tokens ?? null,
    totalTokens: row.total_tokens ?? null,
    cachedTokens: row.cached_tokens ?? null,
    cacheWriteTokens: row.cache_write_tokens ?? null,
    durationMs: row.duration_ms ?? null,
    status: row.status ?? null,
  };
}

/** `undefined` 不能当参数绑，统一转成 `null`。 */
export function insertUsage(record: UsageRecord): void {
  db.prepare(
    `INSERT INTO usage_record
       (ts, provider, account, model, effort, credit,
        prompt_tokens, completion_tokens, reasoning_tokens, total_tokens,
        cached_tokens, cache_write_tokens, duration_ms, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.ts,
    record.provider || LEGACY_PROVIDER,
    record.account ?? null,
    record.model ?? null,
    record.effort ?? null,
    record.credit ?? null,
    record.promptTokens ?? null,
    record.completionTokens ?? null,
    record.reasoningTokens ?? null,
    record.totalTokens ?? null,
    record.cachedTokens ?? null,
    record.cacheWriteTokens ?? null,
    record.durationMs ?? null,
    record.status ?? null,
  );
}

/** 导入脚本对账用。 */
export function countUsage(): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM usage_record').get() as { n?: number } | undefined;
  return num(row?.n);
}

/**
 * `SUM(credit)` 会跳过 NULL，正好等于「缺的按 0 算」；token 列必须显式 `COALESCE`，否则
 * `prompt + completion` 里任一个是 NULL 就得出 NULL。
 */
export function usageTotals(filter: UsageFilter = {}, since?: number | null): UsageTally {
  const { sql, params } = whereOf(filter, since);
  const row = db
    .prepare(
      `SELECT COUNT(*)                                                        AS requests,
              COALESCE(SUM(credit), 0)                                        AS credits,
              COALESCE(SUM(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)), 0) AS tokens,
              COALESCE(SUM(COALESCE(prompt_tokens, 0)), 0)                    AS prompt_tokens,
              COALESCE(SUM(COALESCE(completion_tokens, 0)), 0)                AS completion_tokens,
              COALESCE(SUM(COALESCE(cached_tokens, 0)), 0)                    AS cached_tokens,
              COALESCE(SUM(COALESCE(reasoning_tokens, 0)), 0)                 AS reasoning_tokens
         FROM usage_record ${sql}`,
    )
    .get(...params) as any;
  return {
    requests: num(row?.requests),
    credits: num(row?.credits),
    tokens: num(row?.tokens),
    promptTokens: num(row?.prompt_tokens),
    completionTokens: num(row?.completion_tokens),
    cachedTokens: num(row?.cached_tokens),
    reasoningTokens: num(row?.reasoning_tokens),
  };
}

/** `status` 可为 NULL，归到 `(none)` 一档——**不能丢**，丢了会让「请求健康」的分母比分子小。 */
export function usageStatusCounts(filter: UsageFilter = {}, since?: number | null): Record<string, number> {
  const { sql, params } = whereOf(filter, since);
  const rows = db
    .prepare(
      `SELECT CASE WHEN status IS NULL THEN '(none)' ELSE CAST(status AS TEXT) END AS k,
              COUNT(*) AS n
         FROM usage_record ${sql}
        GROUP BY k`,
    )
    .all(...params) as any[];
  const counts: Record<string, number> = {};
  for (const row of rows) counts[String(row.k)] = num(row.n);
  return counts;
}

/**
 * 哪些通道**一次都没报过** `credit`（窗口内全是 NULL）。
 *
 * Trae 和 WorkBuddy 只报 token、不报单次积分，所以它们的 `credit` 恒为 NULL。
 * 「已用积分」卡片据此显示 `—` 而不是 `0`——**0 会被读成「用了但没花钱」**，
 * 而事实是「这个通道不提供这个数」。
 *
 * 只返回**有请求但全无 credit** 的通道：一个请求都没有的通道不进来，
 * 那属于「今天没用过」，不是「不报」。
 */
export function usageProvidersWithoutCredit(filter: UsageFilter = {}, since?: number | null): string[] {
  const { sql, params } = whereOf(filter, since);
  const rows = db
    .prepare(
      `SELECT provider,
              COUNT(*) AS total,
              SUM(CASE WHEN credit IS NULL THEN 1 ELSE 0 END) AS nulls
         FROM usage_record ${sql}
        GROUP BY provider`,
    )
    .all(...params) as any[];
  const out: string[] = [];
  for (const row of rows) {
    const total = num(row.total);
    // 全是 NULL 才算「不报」；有任何一个有值就说明这个通道报得了，只是有些请求缺。
    if (total > 0 && num(row.nulls) === total) out.push(String(row.provider));
  }
  return out.sort();
}

/**
 * 近 N 天按「天 × 模型 × 账号 × 通道」分组。
 *
 * **按 `MIN(id)` 排序**（= 首次出现的顺序）：`GROUP BY` 本身按分组键排，而旧实现是 Map 的
 * 插入顺序，两者在 token 相同的行上会排出不同结果，让「逐位比对旧数据」做不下去。
 *
 * **显式 `+8 hours` 而不是 `'localtime'`**：日界按北京时间算，不该依赖进程 `TZ`。
 * 2026-11-26 踩过——CI 是 UTC、生产容器是 `Asia/Shanghai`，用 `'localtime'` 两边
 * 分桶会差一天。上海没有夏令时，`+8` 是恒定的。
 */
export function usageDailyGroups(filter: UsageFilter = {}, since: number): UsageDailyGroup[] {
  const { sql, params } = whereOf(filter, since);
  const rows = db
    .prepare(
      `SELECT date(ts / 1000, 'unixepoch', '+8 hours')                      AS day,
              model, account, provider,
              COUNT(*)                                                      AS requests,
              COALESCE(SUM(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)), 0) AS tokens,
              COALESCE(SUM(COALESCE(completion_tokens, 0)), 0)              AS completion_tokens,
              COALESCE(SUM(COALESCE(cached_tokens, 0)), 0)                  AS cached_tokens,
              COALESCE(SUM(credit), 0)                                      AS credits,
              MIN(id)                                                       AS first_id
         FROM usage_record ${sql}
        GROUP BY day, model, account, provider
        ORDER BY first_id`,
    )
    .all(...params) as any[];
  return rows.map((row) => ({
    day: String(row.day),
    model: row.model ?? null,
    account: row.account ?? null,
    provider: row.provider ?? null,
    requests: num(row.requests),
    tokens: num(row.tokens),
    completionTokens: num(row.completion_tokens),
    credits: num(row.credits),
  }));
}

/** 模型为空的归 `(unknown)`，而按账号分桶里那一档叫 `(未标注)`——历史遗留，界面读的是字符串本身。 */
export function usageModelGroups(filter: UsageFilter = {}, since?: number | null): UsageGroup[] {
  const { sql, params } = whereOf(filter, since);
  const rows = db
    .prepare(
      `SELECT COALESCE(NULLIF(model, ''), '(unknown)')                      AS k,
              COUNT(*)                                                      AS requests,
              COALESCE(SUM(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)), 0) AS tokens,
              COALESCE(SUM(COALESCE(prompt_tokens, 0)), 0)                  AS prompt_tokens,
              COALESCE(SUM(COALESCE(completion_tokens, 0)), 0)              AS completion_tokens,
              COALESCE(SUM(COALESCE(cached_tokens, 0)), 0)                  AS cached_tokens,
              COALESCE(SUM(credit), 0)                                      AS credits,
              MIN(id)                                                       AS first_id
         FROM usage_record ${sql}
        GROUP BY k
        ORDER BY first_id`,
    )
    .all(...params) as any[];
  return rows.map(groupOf);
}

/** `since` 省略就是全时段，给了就是「今天」那一档。 */
export function usageAccountGroups(filter: UsageFilter = {}, since?: number | null): UsageGroup[] {
  const { sql, params } = whereOf(filter, since);
  const rows = db
    .prepare(
      `SELECT COALESCE(NULLIF(account, ''), '(未标注)')                     AS k,
              COUNT(*)                                                      AS requests,
              COALESCE(SUM(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)), 0) AS tokens,
              COALESCE(SUM(COALESCE(prompt_tokens, 0)), 0)                  AS prompt_tokens,
              COALESCE(SUM(COALESCE(completion_tokens, 0)), 0)              AS completion_tokens,
              COALESCE(SUM(COALESCE(cached_tokens, 0)), 0)                  AS cached_tokens,
              COALESCE(SUM(credit), 0)                                      AS credits,
              MIN(id)                                                       AS first_id
         FROM usage_record ${sql}
        GROUP BY k
        ORDER BY first_id`,
    )
    .all(...params) as any[];
  return rows.map(groupOf);
}

function groupOf(row: any): UsageGroup {
  return {
    key: String(row.k),
    requests: num(row.requests),
    tokens: num(row.tokens),
    promptTokens: num(row.prompt_tokens),
    completionTokens: num(row.completion_tokens),
    cachedTokens: num(row.cached_tokens),
    credits: num(row.credits),
  };
}

/**
 * **成功与非成功各取一批**，不是简单地「最后 N 条」：实测某时刻账本最后 20 条**全是 499**
 * （一个长会话在陆续断开重连），于是「最近请求」整张表全是「中断」，看不出服务能不能用。
 *
 * 用 `id DESC` 而不是 `ts DESC`：`id` 才是写入顺序，`ts` 可能因为时钟回拨而不单调。
 */
export function usageRecent(
  filter: UsageFilter = {},
  limit = 10,
): { ok: UsageRecord[]; bad: UsageRecord[] } {
  const { sql, params } = whereOf(filter);
  const select = `SELECT * FROM usage_record ${sql}${sql ? ' AND' : ' WHERE'}`;
  const ok = db
    .prepare(`${select} status = 200 ORDER BY id DESC LIMIT ?`)
    .all(...params, limit)
    .map(rowToRecord);
  const bad = db
    .prepare(`${select} (status IS NULL OR status <> 200) ORDER BY id DESC LIMIT ?`)
    .all(...params, limit)
    .map(rowToRecord);
  return { ok, bad };
}

/** 折合费用**按每条记录自己的时间戳**分峰谷计价，所以只取这几列。 */
export function usagePricingRows(
  filter: UsageFilter,
  since: number,
  until?: number | null,
): { ts: number; provider: string; promptTokens: number; cachedTokens: number | null; completionTokens: number }[] {
  const { sql, params } = whereOf(filter, since, until);
  const rows = db
    .prepare(`SELECT ts, provider, prompt_tokens, cached_tokens, completion_tokens FROM usage_record ${sql}`)
    .all(...params) as any[];
  return rows.map((row) => ({
    ts: num(row.ts),
    // 计价要按通道套「假定缓存命中」（见 `shared/deepseek-pricing.ts`），所以必须带 provider。
    provider: String(row.provider ?? LEGACY_PROVIDER),
    promptTokens: num(row.prompt_tokens),
    // **原样返回 `null`**：`null`（上游没报）和 `0`（报了 0）在计价时都会用假定值，但保留
    // 原始区别，调用方将来要区分还有依据。
    cachedTokens: row.cached_tokens === null || row.cached_tokens === undefined ? null : num(row.cached_tokens),
    completionTokens: num(row.completion_tokens),
  }));
}

/** 今天有耗时的那些一次请求耗时——只为算中位数（平均值会被偶发卡顿毁掉）。 */
export function usageDurations(filter: UsageFilter, since: number): number[] {
  const { sql, params } = whereOf(filter, since);
  const rows = db
    .prepare(`SELECT duration_ms FROM usage_record ${sql}${sql ? ' AND' : ' WHERE'} duration_ms IS NOT NULL`)
    .all(...params) as any[];
  return rows.map((row) => num(row.duration_ms));
}

/**
 * 一个窗口内按账号的 token 合计。不复用 `usageAccountGroups()`：那个还算了四列，而且必须
 * `ORDER BY MIN(id)`，那一步在 9000 行上 4.8ms，而这里不要排序、只要 1.9ms。
 *
 * 键的归一规则必须和 `usageAccountGroups()` 一致（空账号归 `(未标注)`）——两处口径分叉的话，
 * 账号列表页和概览页会对同一个号显示不同数字，而两个数都不会报错。
 */
export function usageAccountTokens(filter: UsageFilter, since: number): Record<string, number> {
  const { sql, params } = whereOf(filter, since);
  const rows = db
    .prepare(
      `SELECT COALESCE(NULLIF(account, ''), '(未标注)')                            AS k,
              COALESCE(SUM(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)), 0) AS tokens
         FROM usage_record ${sql}
        GROUP BY k`,
    )
    .all(...params) as any[];
  const out: Record<string, number> = {};
  for (const row of rows) out[String(row.k)] = num(row.tokens);
  return out;
}

/** 徽标每 60 秒轮询一次，只要这三个数字；原先调 `usageSummary()` 实测 4.92ms，这条 0.033ms。 */
export function usageAccountToday(
  accountId: string,
  since: number,
): { requests: number; tokens: number; credits: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*)                                                          AS requests,
              COALESCE(SUM(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)), 0) AS tokens,
              COALESCE(SUM(credit), 0)                                          AS credits
         FROM usage_record
        WHERE account = ? AND ts >= ?`,
    )
    .get(accountId, since) as any;
  return { requests: num(row?.requests), tokens: num(row?.tokens), credits: num(row?.credits) };
}

/**
 * 按**北京时间的小时**分组（单日 24 小时视图用），`strftime('%H', …)` 返回零填充的 `00`–`23`。
 *
 * **显式 `+8 hours` 而不是 `'localtime'`**：峰谷计价是业务规则（按北京时间），
 * 不该依赖进程 `TZ`。2026-11-26 踩过——CI 是 UTC、生产容器是 `Asia/Shanghai`，
 * 用 `'localtime'` 两边算出不同的小时，`usage-hourly` 测试在 CI 上红了一项。
 * 上海没有夏令时，`+8` 是恒定的。
 */
export function usageHourlyGroups(
  filter: UsageFilter,
  since: number,
  until: number,
): UsageHourGroup[] {
  const { sql, params } = whereOf(filter, since, until);
  const rows = db
    .prepare(
      `SELECT strftime('%H', ts / 1000, 'unixepoch', '+8 hours')            AS hour,
              COUNT(*)                                                      AS requests,
              COALESCE(SUM(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)), 0) AS tokens,
              COALESCE(SUM(COALESCE(prompt_tokens, 0)), 0)                  AS prompt_tokens,
              COALESCE(SUM(COALESCE(completion_tokens, 0)), 0)              AS completion_tokens,
              COALESCE(SUM(COALESCE(cached_tokens, 0)), 0)                  AS cached_tokens,
              COALESCE(SUM(credit), 0)                                      AS credits
         FROM usage_record ${sql}
        GROUP BY hour
        ORDER BY hour`,
    )
    .all(...params) as any[];
  return rows.map((row) => ({
    hour: String(row.hour),
    requests: num(row.requests),
    tokens: num(row.tokens),
    promptTokens: num(row.prompt_tokens),
    completionTokens: num(row.completion_tokens),
    cachedTokens: num(row.cached_tokens),
    credits: num(row.credits),
  }));
}
