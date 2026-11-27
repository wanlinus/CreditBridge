// 按请求记录的用量账本：每次请求往 `usage_record` 追加一行，并从这里聚合出面板要的一切。
// 2026-11-22 曾拆成 `ledger/` 下 4 个文件又合回来（拆完 record.ts 只剩 35 行代码）；文件长是因为注释，不是逻辑复杂。
// 三段职责：写入口 `recordChatUsage` · 汇总 `usageSummary` · 单日 `usageHourly`（`pricingRows` 两条读路径共用）。
import { log } from './logger.ts';
import { beijingDate, beijingHour, beijingMidnight, beijingToday, beijingWeekday } from './shared/clock.ts';
import {
  CACHE_ESTIMATE_FALLBACK_RATE,
  CACHE_ESTIMATED_PROVIDERS,
  DEFAULT_PRICING_MODEL,
  cachedForPricing,
  estimateCostOfRecords,
  isPeakHour,
  measuredCacheHitRate,
  type CostBreakdown,
} from './shared/deepseek-pricing.ts';
import {
  LEGACY_PROVIDER,
  insertUsage,
  usageAccountGroups,
  usageDailyGroups,
  usageDurations,
  usageHourlyGroups,
  usageModelGroups,
  usagePricingRows,
  usageProvidersWithoutCredit,
  usageRecent,
  usageStatusCounts,
  usageTotals,
} from './store/usage.ts';

// ---------------------------------------------------------------- 写入口

/** 写库失败**只记日志**，不往上抛：账本丢一行只是少一条统计，抛出去会让已经把响应发出去的请求变成 500。 */
function recordUsage(entry: any) {
  try {
    insertUsage(entry);
  } catch (error: any) {
    log(`usage db insert failed: ${error.message}`);
  }
}

// 追加一行用量，顺便把上游 `usage` 对象的形状归一化。`provider` / `account` 都由路由层传——给默认值就只能写死某个通道或账号，「加通道」「加账号」又变成改这里。
export function recordChatUsage(
  usage: any,
  model: any,
  effort: any,
  started: any,
  status: any,
  provider: string,
  account: string | null = null,
) {
  recordUsage({
    ts: Date.now(),
    provider,
    account,
    model,
    // `effort` 记的是**通道实际发出去的那个值**（Trae 是 light/high/extra_high，WorkBuddy 是 low/medium/high/xhigh/max），所以这一列只能横向比同一通道内的变化。
    effort,
    // `credit` 只取上游报的单次成本。Trae / WorkBuddy 根本不报，所以它们的行恒为 `null`——
    // 积分不在这里逐请求结算，只读官方余额（2026-11-13 起，见 ADR-8/9）。
    credit: typeof usage?.credit === 'number' ? usage.credit : null,
    promptTokens: usage?.prompt_tokens ?? null,
    completionTokens: usage?.completion_tokens ?? null,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
    totalTokens: usage?.total_tokens ?? null,
    // 缓存读取量是 `promptTokens` 的**子集**，不是额外增量（OpenAI 口径），单独记一列才能算真实命中率，加进 `totalTokens` 会把命中的前缀算两遍。上游没报就是 `null`，**不用 0 顶替**——「不知道」和「确实为 0」不是一回事。
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? null,
    cacheWriteTokens: usage?.prompt_tokens_details?.cache_write_tokens ?? null,
    durationMs: Date.now() - started,
    status,
  });
}

// ---------------------------------------------------------------- 计价行

/** 一条参与计价的记录，已按通道补上推算后的缓存量。 */
interface PricingRow {
  ts: number;
  provider: string;
  promptTokens: number;
  /** **生效的**缓存量：上游报了就照原值，不报的通道按实测率推算。 */
  cachedTokens: number;
  completionTokens: number;
  /** `cachedTokens` 里有多少是推算出来的（上游实测的为 0）。 */
  assumedCached: number;
}

/** 取一个窗口的计价行 + 该窗口的实测缓存命中率。`until` 右开（`ts < until`），用于单日视图。 */
function pricingRows(
  filter: { provider?: string | null; account?: string | null },
  since: number,
  until?: number | null,
): { rows: PricingRow[]; rate: number | null } {
  const raw = usagePricingRows(filter, since, until);
  const rate = measuredCacheHitRate(raw);
  const rows = raw.map((row) => {
    const { cached, assumed } = cachedForPricing(row.provider, row.promptTokens, row.cachedTokens, rate);
    return {
      ts: row.ts,
      provider: row.provider,
      promptTokens: row.promptTokens,
      cachedTokens: cached,
      completionTokens: row.completionTokens,
      assumedCached: assumed,
    };
  });
  return { rows, rate };
}

// ---------------------------------------------------------------- 汇总

/** 一个维度桶。`tokens` 是主值（输入 + 输出）；`completionTokens` 单独留一份给「仅输出」切换。 */
type Bucket = { tokens: number; completionTokens: number; requests: number; credits: number };

/** 往一个维度 Map 里累加一格。三个维度（模型/账号/通道）共用。 */
function addDim(map: Map<string, Bucket>, key: string, group: Bucket): void {
  const sub = map.get(key) || { tokens: 0, completionTokens: 0, requests: 0, credits: 0 };
  sub.tokens += group.tokens;
  sub.completionTokens += group.completionTokens;
  sub.requests += group.requests;
  sub.credits += group.credits;
  map.set(key, sub);
}

// 聚合账本。三个时间窗：`totals` / `byModel` / `byAccount` 是**近 30 个本地日历日**（账本一年 60 万行，全表 SUM 会随时间长成「每 60 秒扫一遍全表」）、
// `daily[]` 近 14 天、`today` 今天 0 点起。`window` 字段把第一个窗口报给界面——**不要在界面上写死 30**。
export async function usageSummary(options: { provider?: string | null; account?: string | null } = {}) {
  const filter = { provider: options.provider || null, account: options.account || null };
  // **「今天」按北京时间定**，和 SQL 的 `+8 hours` 同一个口径。用本地 `setHours(0,0,0,0)`
  // 在 UTC 进程里会偏 8 小时，导致「今天」的边界和分桶对不上（2026-11-26 在 CI 上把
  // `usage-daily` 干红了 14 项）。
  const todaySince = beijingMidnight(beijingToday());

  // 近 14 天（含今天）按北京日历日分桶。每根柱子里带三个维度的子分组，前端切换维度不用重新请求后端。
  const DAYS = 14;
  const dayKeys: string[] = [];
  const dayBuckets = new Map<
    string,
    {
      date: string;
      credits: number;
      tokens: number;
      requests: number;
      byModel: Map<string, Bucket>;
      byAccount: Map<string, Bucket>;
      byProvider: Map<string, Bucket>;
    }
  >();
  for (let i = DAYS - 1; i >= 0; i -= 1) {
    const key = beijingDate(todaySince - i * 86400000);
    dayKeys.push(key);
    dayBuckets.set(key, {
      date: key,
      credits: 0,
      tokens: 0,
      requests: 0,
      byModel: new Map(),
      byAccount: new Map(),
      byProvider: new Map(),
    });
  }
  const oldestDay = todaySince - (DAYS - 1) * 86400000;

  // 总量类聚合的窗口：近 30 个本地日历日（**含今天的第 30 天**），按日历日切边界才不会随运行时刻漂。
  const WINDOW_DAYS = 30;
  const windowSince = todaySince - (WINDOW_DAYS - 1) * 86400000;

  for (const group of usageDailyGroups(filter, oldestDay)) {
    const bucket = dayBuckets.get(group.day);
    // 库里可能有窗口之外的日期（14 天以外），`continue` 掉别新建柱子。
    if (!bucket) continue;
    bucket.requests += group.requests;
    bucket.tokens += group.tokens;
    bucket.credits += group.credits;
    // 维度 key 取不到值时归 "(未标注)"——旧行没有 account/model 字段，不能让图少一段。通道那一档回落到 `workbuddy`，因为 provider 字段是 2026-11 才加的。
    addDim(bucket.byModel, group.model || '(未标注)', group);
    addDim(bucket.byAccount, group.account || '(未标注)', group);
    addDim(bucket.byProvider, group.provider || LEGACY_PROVIDER, group);
  }

  /** 金额/积分保留 4 位小数。 */
  const round = (n: any) => Math.round(n * 10000) / 10000;

  // **token 是主口径**：它是网关唯一亲眼看到、且跨通道可加的量（积分各家的叫法和重置规则都不同，不能相加）。
  // `tokens` 由 prompt + completion 现算，**不读上游的 `total_tokens`**：那个字段不是每个通道都给（Qoder 压根不给）。
  const totals = { ...usageTotals(filter, windowSince), statusCounts: usageStatusCounts(filter, windowSince) };

  // 今天的汇总。`medianDurationMs` 是**中位数不是平均值**（上游偶发几百秒卡顿会把均值拉到没参考价值）。`cost` 是**按
  // DeepSeek 官方价目折合的人民币估算**，不是账单，且**按每条记录自己的时间戳分别计价再汇总**——高峰与空闲价差一倍。
  const durations = usageDurations(filter, todaySince);
  const todayRaw = usageTotals(filter, todaySince);
  const todayPricing = pricingRows(filter, todaySince);
  const today = {
    ...todayRaw,
    statusCounts: usageStatusCounts(filter, todaySince),
    medianDurationMs: durations.length
      ? [...durations].sort((a, b) => a - b)[Math.floor(durations.length / 2)]
      : null,
    // 缓存命中率的口径，**和账本里的 `cachedTokens` 不是一回事**：`rate` 排除「不报缓存的通道」（Trae 报 0 会把整体从 99% 拉到 84%，那是数据缺口不是事实），`measuredRate` 是含它们的旧口径。
    cacheHit: {
      rate: todayPricing.rate,
      measuredRate: todayRaw.promptTokens > 0 ? todayRaw.cachedTokens / todayRaw.promptTokens : null,
      // **生效的缓存量** = 上游原值 + 推算部分。卡片上「省下 X」要读这个：命中率排除了 Trae，省下的量也得同一个口径，否则两个数对不上。
      effectiveCachedTokens: todayRaw.cachedTokens + todayPricing.rows.reduce((sum, row) => sum + row.assumedCached, 0),
      estimated: {
        cachedTokens: todayPricing.rows.reduce((sum, row) => sum + row.assumedCached, 0),
        promptTokens: todayPricing.rows.reduce((sum, row) => sum + (row.assumedCached > 0 ? row.promptTokens : 0), 0),
        rate: todayPricing.rate ?? CACHE_ESTIMATE_FALLBACK_RATE,
        providers: [...CACHE_ESTIMATED_PROVIDERS],
      },
    },
    cost: estimateCostOfRecords(todayPricing.rows, DEFAULT_PRICING_MODEL),
  };

  // 按 token 排序：token 是主口径，而且它对每个通道都有值（积分只在部分通道有）。`creditsPerKToken` 只留「每千 token 花了多少积分」供参考。
  const models = usageModelGroups(filter, windowSince)
    .map((g) => ({
      model: g.key,
      requests: g.requests,
      tokens: g.tokens,
      credits: round(g.credits),
      promptTokens: g.promptTokens,
      completionTokens: g.completionTokens,
    }))
    .map((m) => ({
      ...m,
      creditsPerKToken: m.tokens > 0 && m.credits > 0 ? round((m.credits / m.tokens) * 1000) : null,
    }))
    .sort((a, b) => b.tokens - a.tokens);

  const accountRows = (since?: number | null) =>
    usageAccountGroups(filter, since)
      .map((g) => ({
        account: g.key,
        requests: g.requests,
        tokens: g.tokens,
        promptTokens: g.promptTokens,
        completionTokens: g.completionTokens,
        // 上游实测的缓存量。**不推算**：这里只报事实，Trae 报 0 就是 0，是否折算由消费方决定。
        cachedTokens: g.cachedTokens,
        credits: round(g.credits),
      }))
      .sort((a, b) => b.tokens - a.tokens);

  // 最近请求：**成功与非成功各取一批**，不是「最后 N 条」。实测某时刻账本最后 20 条**全是 499**（一个长会话在陆续断开重连），于是整张表全是「中断」，用户判断不出服务能不能用。
  const recentRows = usageRecent(filter, 10);
  // `usageRecent` 按 id 倒序取，这里翻回升序，好让「ts 相同的两行」的先后与旧实现完全一致（并列毫秒很常见）。
  const recent = [...recentRows.ok.reverse(), ...recentRows.bad.reverse()]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 20);

  return {
    /** `totals` / `byModel` / `byAccount` 覆盖的时间窗。界面拿它拼文案（「近 30 天」），不要在前端写死天数。 */
    window: { days: WINDOW_DAYS, since: windowSince },
    totals: { ...totals, credits: round(totals.credits) },
    today: { ...today, credits: round(today.credits) },
    /**
     * 今天有请求、但一次都没报 `credit` 的通道。
     *
     * 界面据此把「已用积分（今日）」显示成 `—` 而不是 `0`——Trae/WorkBuddy 只报
     * token 不报积分，汇总出来必然是 0，而 0 会被读成「用了但没花钱」。
     */
    todayCreditsMissing: usageProvidersWithoutCredit(filter, todaySince),
    daily: dayKeys.map((key) => {
      const bucket = dayBuckets.get(key)!;
      // Map 转普通对象，给前端用（序列化进页面的 JSON）。
      const mapToObj = (m: Map<string, Bucket>) => {
        const obj: Record<string, Bucket> = {};
        for (const [k, v] of m) {
          obj[k] = {
            tokens: v.tokens,
            completionTokens: v.completionTokens,
            requests: v.requests,
            credits: round(v.credits),
          };
        }
        return obj;
      };
      return {
        ...bucket,
        credits: round(bucket.credits),
        byModel: mapToObj(bucket.byModel),
        byAccount: mapToObj(bucket.byAccount),
        byProvider: mapToObj(bucket.byProvider),
      };
    }),
    byModel: models,
    // 按 token 排序，和 `byModel` 一致——主口径是 token，不是积分。
    byAccount: accountRows(windowSince),
    todayByAccount: accountRows(todaySince),
    recent,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- 单日 24 小时

/** 单日视图里的一个小时。`cost` 恒有值（价目表里没有该模型时才为 `null`）。 */
export interface HourlyBucket {
  /** 0–23，本地小时。 */
  hour: number;
  requests: number;
  tokens: number;
  /** 输入 token（上游原值）。 */
  promptTokens: number;
  completionTokens: number;
  /** **推算缓存**：上游报了就用原值，不报缓存的通道按本窗口实测平均率折算。名字没改成 `estimatedCachedTokens` 是为了少改一处契约，但语义已经从「实测」变成「推算」——它和 `promptTokens` 相减不再等于「未命中输入」。 */
  cachedTokens: number;
  /** `cachedTokens` 里有多少是推算出来的（实测为 0）。 */
  assumedCachedTokens: number;
  credits: number;
  cost: CostBreakdown | null;
  /** 这一小时在不在官方的峰时段里（工作日 9-12 / 14-18）。界面用它上底色。 */
  peak: boolean;
}

/**
 * 解析 `YYYY-MM-DD` 成**北京时间**那一天的 0 点（毫秒）。
 *
 * 复用 `beijingMidnight`（`Date.UTC() - 8h`，不经过进程 `TZ` 也不经过 `Intl` locale）。
 * 回读比对是必要的：`new Date('2026-02-30')` 会进位成 3 月 2 日而不是报错，
 * 不回读就把「不存在的日期」算成真实的日子。
 */
function startOfLocalDate(date: string): number {
  const parsed = beijingMidnight(date);
  if (Number.isNaN(parsed)) throw new Error(`${date} 不是合法日期`);
  if (beijingDate(parsed) !== date) throw new Error(`${date} 不是合法日期`);
  return parsed;
}

/** 一天的毫秒数。**假定没有夏令时**（容器 `TZ=Asia/Shanghai`），理由见 store 的注释。 */
const DAY_MS = 86400000;

// 某一天按 24 小时拆开。**费用必须在这里算**：价目表和峰谷规则在 `shared/deepseek-pricing.ts`，让前端算等于把那张表
// 复制一份到 `web/src`，以后调价必然两边不一致且不报错。费用**逐条记录按各自的 `ts` 判峰谷**再汇总，所以 12:00 / 18:00
// 边界上的记录不会被算错档；桶上的 `peak` 只用于画底色。边界：`date` 是未来 → 抛错；`hours` **恒 24 项**，前端不该自己补齐。
export function usageHourly(
  date: string,
  options: { provider?: string | null; account?: string | null } = {},
) {
  const start = startOfLocalDate(date);
  // 「今天」也按北京时间算，和 `startOfLocalDate` 同一口径——用本地 `setHours(0,0,0,0)`
  // 在 UTC 下会让「今天」提前 8 小时，凌晨查当天的用量会被误判成未来。
  const todayStart = startOfLocalDate(beijingToday());
  if (start > todayStart) throw new Error(`${date} 还没到，不能查未来的用量`);

  const filter = { provider: options.provider || null, account: options.account || null };
  const until = start + DAY_MS;

  const groups = usageHourlyGroups(filter, start, until);
  const byHour = new Map<number, (typeof groups)[number]>();
  for (const group of groups) byHour.set(Number(group.hour), group);

  // 费用要原始行：峰谷是按每条记录自己的 `ts` 判的。`pricingRows()` 同时给出「本窗口的实测缓存率」——必须和**这一天**同一个窗口，不能拿"今天"的率去算历史某天。
  const costWindow = pricingRows(filter, start, until);
  const costRows = costWindow.rows;
  const rowsByHour = new Map<number, typeof costRows>();
  for (const row of costRows) {
    // **按北京时间分桶**，不能用 `getHours()`：那是进程本地时区。
    // 2026-11-26 踩过：CI 是 UTC，北京时间 15:30 的记录被分到 7 点，
    // 而 `isPeakHour()` 判它是高峰——两边矛盾，`usage-hourly` 测试红了一项。
    const hour = beijingHour(row.ts);
    const list = rowsByHour.get(hour);
    if (list) list.push(row);
    else rowsByHour.set(hour, [row]);
  }

  const round = (n: any) => Math.round(n * 10000) / 10000;

  const hours: HourlyBucket[] = [];
  for (let hour = 0; hour < 24; hour += 1) {
    const group = byHour.get(hour);
    const rows = rowsByHour.get(hour) ?? [];
    hours.push({
      hour,
      requests: group?.requests ?? 0,
      tokens: group?.tokens ?? 0,
      promptTokens: group?.promptTokens ?? 0,
      completionTokens: group?.completionTokens ?? 0,
      // **推算缓存**：上游报了就照原值，不报缓存的通道按本窗口实测平均率折算——这是它和 `promptTokens` 不再能相减出"未命中"的原因。
      cachedTokens: group ? rows.reduce((sum, row) => sum + row.cachedTokens, 0) : 0,
      assumedCachedTokens: rows.reduce((sum, row) => sum + row.assumedCached, 0),
      credits: round(group?.credits ?? 0),
      cost: estimateCostOfRecords(rows, DEFAULT_PRICING_MODEL),
      peak: isPeakHour(start + hour * 3600000 + 30 * 60 * 1000),
    });
  }

  const sum = (pick: (bucket: HourlyBucket) => number) => hours.reduce((acc, bucket) => acc + pick(bucket), 0);
  const totalCost = estimateCostOfRecords(costRows, DEFAULT_PRICING_MODEL);

  return {
    date,
    /** 0 = 周日 … 6 = 周六。**按北京时间**，和峰谷规则同一个口径。 */
    weekday: beijingWeekday(start),
    /** 这一天有没有峰时段（工作日才有）。界面用它决定要不要画峰谷底色。 */
    isPeakDay: [1, 2, 3, 4, 5].includes(beijingWeekday(start)),
    hours,
    totals: {
      requests: sum((b) => b.requests),
      tokens: sum((b) => b.tokens),
      promptTokens: sum((b) => b.promptTokens),
      completionTokens: sum((b) => b.completionTokens),
      cachedTokens: sum((b) => b.cachedTokens),
      assumedCachedTokens: sum((b) => b.assumedCachedTokens),
      credits: round(sum((b) => b.credits)),
      cost: totalCost,
    },
    generatedAt: new Date().toISOString(),
  };
}
