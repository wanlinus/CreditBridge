// 按请求记录的用量账本。
//
// 每次请求往 `usage_record` 表追加一行，并从这里聚合出面板要的一切。
//
// 2026-11-22 曾拆成 `ledger/` 下 4 个文件，随后又合回来：拆完之后 record.ts 只有 35 行
// 代码、pricing.ts 只有 30 行，读一条读路径要在三四个文件之间跳。**文件长是因为注释，
// 不是因为逻辑复杂**——该精简的是注释，不是拆文件。
//
// 三段职责，靠下面的分节注释区分：
//   · 写入口      recordChatUsage
//   · 读：汇总    usageSummary（近 30 天总量 + 近 14 天趋势 + 今天）
//   · 读：单日    usageHourly（某一天按 24 小时，恒 24 项）
//   · 计价行      pricingRows（上面两条读路径共用，所以在本文件内是私有函数）

import { log } from './logger.ts';
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
  usageRecent,
  usageStatusCounts,
  usageTotals,
} from './store/usage.ts';

// ---------------------------------------------------------------- 写入口

/**
 * 往账本追加一行原始记录。
 *
 * 写库失败**只记日志**，不往上抛：账本丢了会让统计少一行，而抛出去会让已经把响应
 * 发出去的那个请求变成 500——顺序反了。这个取舍和 `logger` 一样，宁可少一行统计。
 */
function recordUsage(entry: any) {
  try {
    insertUsage(entry);
  } catch (error: any) {
    log(`usage db insert failed: ${error.message}`);
  }
}

/**
 * 追加一行用量，顺便把上游 `usage` 对象的形状归一化。
 *
 * `provider` / `account` 都由路由层传：账本按它们分组，给默认值就只能写死某个通道
 * 或某个账号，那会让「加通道」「加账号」又变成改这里。
 *
 * `account` 是 v2 新增的：同一通道多个号之后，「这个月花的是谁的钱」必须能分开。
 * 旧行没有这个字段，聚合时按 `null` 归到「未标注」一档（不迁移，见 AGENTS.md）。
 */
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
    // `effort` 记的是**通道实际发出去的那个值**：Trae 的档位是 light/high/extra_high，
    // WorkBuddy 是 low/medium/high/xhigh/max。也就是说这一列能横向比的只有「同一个
    // 通道内的变化」，跨通道比没有意义。
    effort,
    // `credit` 取上游报的单次成本。WorkBuddy 的 `usage` 帧里自带；Trae 不报，由
    // 通道在几秒后读账号计数器做差补上，所以偶尔会有几行是空的（结算失败或还没跑完）。
    credit: typeof usage?.credit === 'number' ? usage.credit : null,
    promptTokens: usage?.prompt_tokens ?? null,
    completionTokens: usage?.completion_tokens ?? null,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
    totalTokens: usage?.total_tokens ?? null,
    // 缓存读取量是 `promptTokens` 的**子集**，不是额外增量（OpenAI 口径），所以单独记一列
    // 才能算真实命中率；把它加进 `totalTokens` 会把命中的前缀算两遍。
    // 上游没报这个字段就是 `null`，**不用 0 顶替**——「不知道」和「确实为 0」不是一回事。
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

/**
 * 取一个窗口的计价行 + 该窗口的实测缓存命中率。
 *
 * `until` 右开（`ts < until`），用于单日视图。
 */
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

/**
 * 聚合账本。`provider` 只留某个通道的行，`account` 再收窄到某个账号。
 *
 * 返回对象而不是写 `res`：v2 的路由层是 Hono，响应由它决定。
 *
 * ## 三个时间窗
 *
 * | 字段 | 窗口 | 为什么 |
 * |---|---|---|
 * | `totals` / `byModel` / `byAccount` | **近 30 个本地日历日** | 账本一年 60 万行，全表 `SUM` 会随时间长成「每 60 秒扫一遍全表」。30 天足够回答「最近花了多少」，而扫描量被钉住 |
 * | `daily[]` | 近 14 天 | 趋势图只有 14 根柱子 |
 * | `today` / `todayByAccount` | 今天 0 点起 | 卡片上写的就是「今日」 |
 *
 * `window` 字段把第一个窗口报给界面——**不要在界面上写死 30**（改了窗口却忘了改文案，
 * 用户看到的就是错的口径）。
 */
export async function usageSummary(options: { provider?: string | null; account?: string | null } = {}) {
  const filter = { provider: options.provider || null, account: options.account || null };
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todaySince = startOfToday.getTime();

  // 近 14 天（含今天）按本地日历日分桶，给面板的柱状图用。
  //
  // 每根柱子里带三个维度的子分组（byModel / byAccount / byProvider），这样前端画
  // 堆叠图时切换维度不用重新请求后端——14 天 × 三个维度的数据一次性塞进页面。
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
    const day = new Date(todaySince - i * 86400000);
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
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

  // 总量类聚合的窗口：近 30 个本地日历日（含今天）。**含今天的第 30 天**，不是「从
  // 现在往回 30×24 小时」——和 `daily` 一样按日历日切，边界才不会随运行时刻漂。
  const WINDOW_DAYS = 30;
  const windowSince = todaySince - (WINDOW_DAYS - 1) * 86400000;

  for (const group of usageDailyGroups(filter, oldestDay)) {
    const bucket = dayBuckets.get(group.day);
    // 库里可能有窗口之外的日期（14 天以外），`continue` 掉别新建柱子。
    if (!bucket) continue;
    bucket.requests += group.requests;
    bucket.tokens += group.tokens;
    bucket.credits += group.credits;
    // 维度 key 取不到值时归 "(未标注)"，和旧实现一致——旧行没有 account/model 字段
    // 不能让图少一段。通道那一档回落到 `workbuddy`，因为 provider 字段是 2026-11 才加的。
    addDim(bucket.byModel, group.model || '(未标注)', group);
    addDim(bucket.byAccount, group.account || '(未标注)', group);
    addDim(bucket.byProvider, group.provider || LEGACY_PROVIDER, group);
  }

  /** 金额/积分保留 4 位小数。 */
  const round = (n: any) => Math.round(n * 10000) / 10000;

  // **token 是主口径**：它是网关唯一亲眼看到、且跨通道可加的量。积分各家的叫法和
  // 重置规则都不同（Loomy 每天重置 5000、WorkBuddy 是总额度制），不能相加；token 是
  // 客观计数，和计费方式无关。见 private/docs/v3/overview-redesign.md。
  //
  // `tokens` 由 prompt + completion 现算，**不读上游的 `total_tokens`**：那个字段不是
  // 每个通道都给（Qoder 压根不给 token），而两个分量我们都有，加出来必定一致。
  //
  // 窗口从 `windowSince` 起（近 30 天），不是全表：`idx_usage_ts` 能用上，扫描量也不会
  // 随账本增长。想改窗口只改 `WINDOW_DAYS`——界面读 `window.days`，不用跟着改。
  const totals = { ...usageTotals(filter, windowSince), statusCounts: usageStatusCounts(filter, windowSince) };

  /**
   * 今天的汇总。
   *
   * `medianDurationMs` 是**中位数不是平均值**：上游偶发一次几百秒的卡顿会把均值
   * 拉到没有参考价值，而中位数还代表「典型一次要多久」。
   *
   * `cost` 是**按 DeepSeek 官方价目折合的人民币估算**，不是账单——这些 token 花在
   * WorkBuddy/Trae/Qoder/Loomy 上，不走 DeepSeek 的 API。它提供一个可感的参照系，
   * 并且**一律按 `deepseek-flash` 计价**（见 `shared/deepseek-pricing.ts` 的文件头）。
   *
   * **按每条记录自己的时间戳分别计价再汇总**：官方高峰（北京时间工作日 9-12、14-18 点）
   * 与空闲价差一倍，而「今天」跨了好几个小时。
   */
  const durations = usageDurations(filter, todaySince);
  const todayRaw = usageTotals(filter, todaySince);
  const todayPricing = pricingRows(filter, todaySince);
  const today = {
    ...todayRaw,
    statusCounts: usageStatusCounts(filter, todaySince),
    medianDurationMs: durations.length
      ? [...durations].sort((a, b) => a - b)[Math.floor(durations.length / 2)]
      : null,
    /**
     * 缓存命中率的口径，**和账本里的 `cachedTokens` 不是一回事**：
     *
     * - `rate`：排除「不报缓存的通道」（Trae）之后的实测加权率，界面显示这个。
     *   Trae 报 0 会把整体从 99% 拉到 84%——那是数据缺口，不是事实。
     * - `measuredRate`：含那些通道（按 0 计）的旧口径，留作对照。
     * - `estimated`：被推算出来的部分（Trae 按 `rate` 反推出来的缓存量）。
     */
    cacheHit: {
      rate: todayPricing.rate,
      measuredRate: todayRaw.promptTokens > 0 ? todayRaw.cachedTokens / todayRaw.promptTokens : null,
      /**
       * **生效的缓存量** = 上游原值 + 推算出来的部分。
       *
       * 卡片上「省下 X」要读这个：既然命中率已经排除了 Trae，省下的量也得是同一个口径，
       * 否则「99.0% · 省下 4.28 亿」两个数对不上（4.28 亿是含 Trae 报 0 的原值）。
       */
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

  // 按 token 排序：token 是主口径，而且它对每个通道都有值（积分只在部分通道有）。
  // `creditsPerKToken` 不再反推倍率（见文件头），只留一个「每千 token 花了多少积分」
  // 供参考——它只在同时有 token 和 credit 的模型上有值。
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
        // 上游实测的缓存量。界面用它算「这一档有多少输入是全价」。
        // **不推算**：这里只报事实，Trae 报 0 就是 0，是否折算由消费方决定。
        cachedTokens: g.cachedTokens,
        credits: round(g.credits),
      }))
      .sort((a, b) => b.tokens - a.tokens);

  /**
   * 最近请求：**成功与非成功各取一批**，不是简单地「最后 N 条」。
   *
   * 实测某时刻账本最后 20 条**全是 499**（一个长会话在陆续断开重连），于是「最近
   * 请求」整张表全是「中断」——用户看不到任何成功案例，也判断不出服务到底能不能用。
   *
   * 两边各取 10 条再按时间倒排，前端取前 8 条。这样无论当下是「全成功」还是
   * 「全中断」，表里都同时有两种状态；真的没有某种状态时，那就是事实。
   */
  const recentRows = usageRecent(filter, 10);
  // `usageRecent` 按 id 倒序取，这里翻回升序，好让「ts 相同的两行」的先后与旧实现
  // 完全一致（旧实现是文件顺序）。差值只在并列毫秒时可见，但并列是常见的。
  const recent = [...recentRows.ok.reverse(), ...recentRows.bad.reverse()]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 20);

  return {
    /**
     * `totals` / `byModel` / `byAccount` 覆盖的时间窗。界面拿它拼文案（「近 30 天」），
     * 不要在前端写死天数——改了窗口忘了改文案，用户看到的就是错的口径。
     */
    window: { days: WINDOW_DAYS, since: windowSince },
    totals: { ...totals, credits: round(totals.credits) },
    today: { ...today, credits: round(today.credits) },
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
  /**
   * **推算缓存**：上游报了就用原值，不报缓存的通道按本窗口实测平均率折算。
   *
   * 名字没改成 `estimatedCachedTokens` 是为了少改一处契约，但**语义已经从"实测"变成
   * "推算"**——所以它和 `promptTokens` 相减不再等于"未命中输入"，界面标题也必须写
   * 「推算缓存」而不是「其中缓存」。
   */
  cachedTokens: number;
  /** `cachedTokens` 里有多少是推算出来的（实测为 0）。 */
  assumedCachedTokens: number;
  credits: number;
  cost: CostBreakdown | null;
  /** 这一小时在不在官方的峰时段里（工作日 9-12 / 14-18）。界面用它上底色。 */
  peak: boolean;
}

/**
 * 解析 `YYYY-MM-DD` 成本地日历日 0 点（毫秒）。
 *
 * **必须回读比对**：`new Date('2026-02-30T00:00:00')` 不会报错，它会进位成 3 月 2 日；
 * 不回读就会把「不存在的日期」算成一个真实的日子，而且返回的 `date` 和请求的不一样。
 */
function startOfLocalDate(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error('date 要是 YYYY-MM-DD');
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${date} 不是合法日期`);
  const roundTrip = `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
  if (roundTrip !== date) throw new Error(`${date} 不是合法日期`);
  return parsed.getTime();
}

/** 一天的毫秒数。**假定没有夏令时**（容器 `TZ=Asia/Shanghai`），理由见 store 的注释。 */
const DAY_MS = 86400000;

/**
 * 某一天按 24 小时拆开：给「点柱子进单日」那个页面用。
 *
 * ## 为什么费用必须在这里算
 *
 * 价目表和峰谷规则在 `shared/deepseek-pricing.ts`。如果让前端算，等于把那张表复制
 * 一份到 `web/src`——以后调价必然两边不一致，而且不会有任何报错。
 *
 * 费用**逐条记录按各自的 `ts` 判峰谷**再汇总（复用 `estimateCostOfRecords`），
 * 所以峰谷边界（12:00 / 18:00）上的记录不会被算错档。桶上的 `peak` 只用于画底色，
 * 由桶的起始时刻 +30 分钟判断（时段边界都落在整点，半小时足够）。
 *
 * ## 三个边界
 *
 * - `date` 是未来 → 抛错（路由转 400）。未来的日子没有「今天还没过完」这回事。
 * - 今天 → 未来的小时补 0，合计只统计已有记录。
 * - `hours` **恒 24 项**，和 `daily` 恒 14 项同理：前端不该自己补齐。
 */
export function usageHourly(
  date: string,
  options: { provider?: string | null; account?: string | null } = {},
) {
  const start = startOfLocalDate(date);
  const todayStart = (() => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return now.getTime();
  })();
  if (start > todayStart) throw new Error(`${date} 还没到，不能查未来的用量`);

  const filter = { provider: options.provider || null, account: options.account || null };
  const until = start + DAY_MS;

  const groups = usageHourlyGroups(filter, start, until);
  const byHour = new Map<number, (typeof groups)[number]>();
  for (const group of groups) byHour.set(Number(group.hour), group);

  // 费用要原始行：峰谷是按每条记录自己的 `ts` 判的，不能拿桶里的合计去算。
  // `pricingRows()` 同时给出「本窗口的实测缓存率」——不报缓存的通道按这个率推算，
  // 所以它必须和**这一天**同一个窗口，不能拿"今天"的率去算历史某天。
  const costWindow = pricingRows(filter, start, until);
  const costRows = costWindow.rows;
  const rowsByHour = new Map<number, typeof costRows>();
  for (const row of costRows) {
    const hour = new Date(row.ts).getHours();
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
      // **推算缓存**：上游报了就照原值，不报缓存的通道按本窗口实测平均率折算。
      // 这是这一列和 `promptTokens` 不再能相减出"未命中"的原因，界面标题写的是「推算缓存」。
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
    /** 0 = 周日 … 6 = 周六。 */
    weekday: new Date(start).getDay(),
    /** 这一天有没有峰时段（工作日才有）。界面用它决定要不要画峰谷底色。 */
    isPeakDay: [1, 2, 3, 4, 5].includes(new Date(start).getDay()),
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
