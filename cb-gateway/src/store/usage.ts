// 用量账本的表（`usage_record`）——**唯一允许出现 SQL 的地方之一**。
//
// 导出的是**语义化函数**而不是泛型 CRUD：名字里带查询意图，调用方就写不出「把 60 万行
// 拉进内存」那种代码。返回的也一律是领域对象（camelCase），不是数据库的 snake_case 行
// ——列名映射只在本文件做一处。
//
// 同步、不返回 Promise：`DatabaseSync` 就是同步的，包成 async 只会让调用点凭空多一层
// `await`，还会让人误以为这里在做 IO 等待。

import { db } from '../shared/db.ts';

/**
 * 账本里没有 `provider` 字段的那些行算谁的。
 *
 * 这是**历史事实**，不是通道清单：`provider` 字段是 2026-11 加的，在那之前的行
 * 全是 WorkBuddy 的流量。写成一个常量而不是从注册表推，是因为注册表的顺序、增减
 * 都会变，而「这些旧行属于谁」不会变。
 *
 * 放在 store 里是因为**写库和查库都要用它**：导入脚本要按它归一旧行，聚合要按它
 * 归桶。放两份就会出现「导入用一套、查询用另一套」的静默不一致。
 */
export const LEGACY_PROVIDER = 'workbuddy';

/** 账本的筛选条件。`null` / 省略表示不限。 */
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

/** 按某个维度分组的总体统计。 */
export interface UsageGroup {
  key: string;
  requests: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  credits: number;
  /**
   * 上游实测的缓存读取量（`prompt_tokens` 的子集）。
   *
   * 界面用 `promptTokens - cachedTokens` 判断「这一档有多少输入是全价算的」。
   * 不报缓存的通道（Trae）会算出「全部未命中」，所以消费方必须自己决定
   * 要不要把它算进分母——账本只报事实，不做通道语义。
   */
  cachedTokens: number;
}

/** 按某一个小时分组的统计（单日视图用）。 */
export interface UsageHourGroup {
  /** `00`–`23`，**零填充的字符串**（`strftime('%H')` 的输出形状）。 */
  hour: string;
  requests: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  credits: number;
}

const num = (value: unknown): number => Number(value) || 0;

/**
 * 拼 WHERE。**只用 `?` 占位**，永远不拼字符串——虽然这里的值都来自内部调用，
 * 但「这次是内部的所以可以拼」是漏洞的开始。
 *
 * `until` 是**右开**（`ts < until`）：单日视图要 `[今天 0 点, 明天 0 点)`，用闭区间
 * 会把第二天 0 点整的那条记录算进今天。
 */
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

/** 数据库行 → 领域对象。列名映射只有这一处，改列名不会静默错位。 */
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

/** 追加一行。`undefined` 不能当参数绑，这里统一转成 `null`。 */
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

/** 总行数。导入脚本对账用（「文件里多少行，库里就该多少行」）。 */
export function countUsage(): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM usage_record').get() as { n?: number } | undefined;
  return num(row?.n);
}

/**
 * 一个区间的汇总。
 *
 * `SUM(credit)` 会跳过 NULL，正好等于「缺的按 0 算」；其他 token 列必须显式
 * `COALESCE`，否则整行有 NULL 时 `SUM` 跳过它——那是对的，但 `prompt + completion`
 * 里任一个是 NULL 就得出 NULL，所以要先各自归零再相加。
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

/**
 * 按 HTTP 状态码计数。
 *
 * `status` 可为 NULL（旧行/异常路径），归到 `(none)` 一档——**不能丢**：概览页的
 * 「请求健康」要拿 `200` 和 `499` 两个值，丢掉 NULL 会让分母比分子小。
 */
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
 * 近 N 天按「天 × 模型 × 账号 × 通道」分组。
 *
 * **一次查到底再在 JS 里摊开三个维度**，而不是每个维度查一遍：三个维度的分组
 * 交叉起来也就几十格（一天几个模型 × 几个账号），三道 SQL 只是让代码更长。
 *
 * **按 `MIN(id)` 排序**（= 首次出现的顺序）：`GROUP BY` 本身的输出顺序按分组键排，
 * 而旧实现是 Map 的插入顺序。两者在「token 相同」的行上会排出不同结果，界面上就是
 * 两条并列的模型换个位置——不影响数字，但会让「逐位比对旧数据」这件事做不下去。
 *
 * `date(ts / 1000, 'unixepoch', 'localtime')` **依赖容器的 `TZ`**：`Dockerfile` 和
 * `compose.yaml` 都设了 `Asia/Shanghai`。丢了会让分桶整体偏一天，而且不报错。
 */
export function usageDailyGroups(filter: UsageFilter = {}, since: number): UsageDailyGroup[] {
  const { sql, params } = whereOf(filter, since);
  const rows = db
    .prepare(
      `SELECT date(ts / 1000, 'unixepoch', 'localtime')                     AS day,
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

/**
 * 按模型汇总。
 *
 * 模型为空的归 `(unknown)`——**注意这里是英文**，而按天分桶里那一档叫 `(未标注)`。
 * 两处不一致是历史遗留（先有 byModel 后有分桶），但界面读的是这些字符串本身，
 * 改哪个都会让图表多出一段，所以保持原样。
 *
 * `since` 用来收窄时间窗（`ledger.ts` 传近 30 天）：全表 `SUM` 会随账本一年 60 万行
 * 一起变慢，而「最近的模型用量」本来就不需要全史。
 */
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

/** 按账号汇总。`since` 省略就是全时段，给了就是「今天」那一档。 */
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
 * 最近请求：**成功与非成功各取一批**，不是简单地「最后 N 条」。
 *
 * 实测某时刻账本最后 20 条**全是 499**（一个长会话在陆续断开重连），于是「最近请求」
 * 整张表全是「中断」——用户看不到任何成功案例，也判断不出服务到底能不能用。
 *
 * 用 `id DESC` 取「最后 N 条」而不是 `ts DESC`：`id` 才是写入顺序，与 JSONL 时代
 * 的 `slice(-N)` 等价；`ts` 可能因为时钟回拨而不单调。
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

/**
 * 参与计价的那几列。
 *
 * 只取 `ts` 和三个 token 数，不返回整行：折合费用**按每条记录自己的时间戳**分峰谷
 * 计价（见 `shared/deepseek-pricing.ts`），其他字段一个都用不上。
 *
 * `until` 右开，用于单日视图（`[当天 0 点, 次日 0 点)`）。
 */
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
    // 计价要按通道套「假定缓存命中」（见 `shared/deepseek-pricing.ts`），所以这里必须带 provider。
    provider: String(row.provider ?? LEGACY_PROVIDER),
    promptTokens: num(row.prompt_tokens),
    // **原样返回 `null`**：`null`（上游没报）和 `0`（报了 0）在计价时都会用假定值，
    // 但保留原始区别，调用方将来要区分还有依据。
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
 * 一个窗口内按账号的 token 合计——只取两个数字。
 *
 * 不复用 `usageAccountGroups()`：那个还算了 prompt / completion / cached / credits 四列，
 * 而调用方只要 tokens。更关键的是它必须 `ORDER BY MIN(id)`（逐位比对旧数据要靠它），
 * 那一步在 9000 行上 4.8ms，而这里不需要排序、只要 1.9ms。
 *
 * 键的归一规则必须和 `usageAccountGroups()` 一致（空账号归 `(未标注)`）——两处口径
 * 分叉的话，账号列表页和概览页会对同一个号显示不同数字，而两个数都不会报错。
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

/**
 * 单个账号在一个窗口内的三个数：请求数、token、积分。
 *
 * ## 为什么值得单独一条
 *
 * 徽标（`GET /api/accounts/<id>/badge`）每 60 秒轮询一次，只需要「今天几次、多少
 * token、多少积分」这三个数字。原先它调 `usageSummary({account})`——实测 **4.92ms**，
 * 而这个接口被轮询的频率最高。这一条 SQL 实测 **0.033ms**，差 150 倍。
 *
 * 省下的不只是时间：`usageSummary` 会算 14 天三维度分桶、最近 20 条、模型聚合、
 * 缓存推算、DeepSeek 折合费用——**全是为了别的页面**，徽标一个都不读。
 */
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
 * 一个时间区间内按**本地小时**分组（单日 24 小时视图用）。
 *
 * `strftime('%H', …)` 返回零填充的 `00`–`23`，直接当桶的键。
 *
 * **依赖容器 `TZ=Asia/Shanghai`**（和 `usageDailyGroups` 的 `date()` 同一个前提）：
 * 上海没有夏令时，所以一天恒 24 小时。如果哪天部署到有 DST 的时区，那天会是 23 或 25
 * 个桶——`ledger.ts` 会按 24 个格子铺，多出来的小时会被丢掉。这是刻意的取舍：
 * 为一个不会发生的部署环境加一套 DST 处理，比这个注释更难维护。
 */
export function usageHourlyGroups(
  filter: UsageFilter,
  since: number,
  until: number,
): UsageHourGroup[] {
  const { sql, params } = whereOf(filter, since, until);
  const rows = db
    .prepare(
      `SELECT strftime('%H', ts / 1000, 'unixepoch', 'localtime')            AS hour,
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
