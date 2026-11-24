// DeepSeek 官方价目（人民币），给账本里的 token 估一个「按 DeepSeek 价折合多少钱」。
//
// **这不是账单**：这些 token 花在四家上游上，不走 DeepSeek 的 API。它只是参照系，
// 让「2 亿 token」有个可感的尺度。
//
// 价目来源 https://api-docs.deepseek.com/zh-cn/quick_start/pricing/（2026-11-13 抓取，
// 单位：元 / 百万 tokens）：
//
//   | 项目              | 空闲 | 高峰 |
//   | 输入（缓存命中）   | 0.02 | 0.04 |
//   | 输入（未命中）     | 1    | 2    |
//   | 输出              | 4    | 8    |
//
// **一律按 `deepseek-flash` 计价，不按模型分档**：数字本来就是参照系，「哪个上游模型
// 对哪一档 DeepSeek 价」是一张跨通道映射表，收益不抵复杂度。
//
// 峰谷规则（官方原文）：北京时间周一至周五 9:00-12:00、14:00-18:00 为高峰，其余
// （含周末）为空闲。**空闲价正好是高峰的一半**，所以只维护高峰价，空闲价现算。
//
// **法定节假日没有内置**：节假日安排每年由国务院发布（还带调休），内置会过期，而
// 过期的数据比没有更糟——它会静默把高峰当空闲算、少报费用。影响量级很小：一年约
// 11 天，且只影响落在 9-12 / 14-18 点的那部分。
/** 每 1M token 的人民币价格。 */
export interface ModelPrice {
  /** 命中缓存的输入。 */
  inputCacheHit: number;
  /** 未命中缓存的输入。 */
  inputCacheMiss: number;
  /** 输出。 */
  output: number;
}

/** 一小时、一美元的千分之一这类中间量都按「元」算，不做四舍五入。 */
export const CURRENCY = 'CNY';

/**
 * DeepSeek 官方价目（**高峰时段**，元 / 1M token）。
 *
 * 只有 `deepseek-flash` 一档，原因见文件头「为什么只有一个模型的价格」。
 * 空闲价 = 高峰价 ÷ 2，见文件头的官方原文。
 */
export const DEEPSEEK_PEAK_PRICES: Record<string, ModelPrice> = {
  // 官方模型名就是 `deepseek-flash`（旧的 `deepseek-v4-flash` 已退役，仍按这个价收）
  'deepseek-flash': { inputCacheHit: 0.04, inputCacheMiss: 2, output: 8 },
};

/** 算价用的模型。只有 flash 一档——账本里所有模型都按它折算。 */
export const DEFAULT_PRICING_MODEL = 'deepseek-flash';

/**
 * 这个时刻是不是**高峰时段**。
 *
 * 规则（官方原文）：北京时间周一至周五 9:00-12:00、14:00-18:00。
 * 区间左闭右开——12:00 整已经不算高峰，18:00 整亦然。
 *
 * **「北京时间」是业务规则，不是运行环境属性**，所以这里显式按 `Asia/Shanghai`
 * 换算，不看进程的 `TZ`。2026-11-25 踩到的：本地是 UTC+8、GitHub Actions 是 UTC，
 * 按本地时间判断会让同一批数据在 CI 里算错 8 小时（峰谷全反），
 * `test:deepseek-pricing` 59 项里失败 15 项。
 *
 * 法定节假日的偏差见文件头。
 */
export function isPeakHour(at: number = Date.now()): boolean {
  // 用 Intl 拿北京时间的星期和小时，不依赖进程 TZ。
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date(at));
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  // `hour12: false` 在午夜会给出 "24"，统一成 0。
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

/** 一个请求的计价结果。 */
export interface CostBreakdown {
  /** 合计（元）。 */
  cny: number;
  /** 其中高峰时段的部分。 */
  peakCny: number;
  /** 其中空闲时段的部分。 */
  offPeakCny: number;
  /** 高峰时段的 token 数（输入 + 输出）。 */
  peakTokens: number;
  /** 空闲时段的 token 数。 */
  offPeakTokens: number;
  /** 参与计价的「缓存命中输入」token 数。 */
  cacheHit: number;
  /** 参与计价的「缓存未命中输入」token 数（`prompt − cached`）。 */
  cacheMiss: number;
  /** 参与计价的输出 token 数。 */
  output: number;
  /**
   * `cacheHit` 里有多少是**假定**的（上游没报缓存，按 `ASSUMED_CACHE_HIT_BY_PROVIDER` 折算）。
   *
   * 界面必须能看见它：不标出来的假定就是假数据。
   */
  assumedCachedTokens: number;
}

/** 把一批 token 按给定单价算成元。 */
function priceOf(
  tokens: { prompt: number; cached: number; output: number },
  price: ModelPrice,
): number {
  const miss = Math.max(0, tokens.prompt - tokens.cached);
  return (
    (tokens.cached / 1e6) * price.inputCacheHit +
    (miss / 1e6) * price.inputCacheMiss +
    (tokens.output / 1e6) * price.output
  );
}

/** 空闲价 = 高峰价 ÷ 2（官方原文：「空闲时段价格为高峰时段价格的一半」）。 */
function offPeakOf(price: ModelPrice): ModelPrice {
  return {
    inputCacheHit: price.inputCacheHit / 2,
    inputCacheMiss: price.inputCacheMiss / 2,
    output: price.output / 2,
  };
}

/**
 * 把一批**同属一个时段**的 token 折算成元。
 *
 * `at` 决定用高峰价还是空闲价；省略时按「现在」判断。
 *
 * **生产路径不用它**（用的是下面的 `estimateCostOfRecords`，因为一条请求跨时段时
 * 必须逐条判峰谷）。它留在导出面上有两个用途：`test:deepseek-pricing` 用它钉住
 * 单价和峰谷规则本身，以及给「单条记录、已知时刻」这类一次性验算当工具。
 * 删掉它会让那套测试失去唯一的纯函数入口。
 */
export function estimateCost(
  tokens: {
    promptTokens?: number | null;
    cachedTokens?: number | null;
    completionTokens?: number | null;
  },
  model: string = DEFAULT_PRICING_MODEL,
  at: number = Date.now(),
): CostBreakdown | null {
  const price = DEEPSEEK_PEAK_PRICES[model];
  if (!price) return null;

  const prompt = Number(tokens.promptTokens) || 0;
  // 防御：`cached` 不该超过 `prompt`。超过了说明上游口径变了，夹一下免得算出负的未命中。
  const cached = Math.min(Number(tokens.cachedTokens) || 0, prompt);
  const output = Number(tokens.completionTokens) || 0;
  const peak = isPeakHour(at);

  const cny = priceOf({ prompt, cached, output }, peak ? price : offPeakOf(price));
  return {
    cny,
    peakCny: peak ? cny : 0,
    offPeakCny: peak ? 0 : cny,
    peakTokens: peak ? prompt + output : 0,
    offPeakTokens: peak ? 0 : prompt + output,
    cacheHit: cached,
    cacheMiss: Math.max(0, prompt - cached),
    output,
    // 单条记录这一层不做假定：假定是按通道的，由 `cachedForPricing()` 在调用方算好
    // 再传进来（否则这个纯函数就得认识「通道」这个概念）。
    assumedCachedTokens: 0,
  };
}

/**
 * 把**多条记录**的 token 按各自的时间戳分别计价后汇总。
 *
 * **这是仪表真正用的入口**：跨小时的用量里既有高峰也有空闲，统一按一个价算会失真
 * 一倍。单条记录用 `estimateCost` 时传的是固定时刻，两者算法一致（都走 `priceOf`）。
 *
 * 日界线的处理不在这一层：调用方传进来的就是「今天」那些行。
 */
export function estimateCostOfRecords(
  records: {
    ts: number;
    promptTokens?: number | null;
    cachedTokens?: number | null;
    completionTokens?: number | null;
    /** 其中有多少是**假定**的缓存命中（由 `cachedForPricing()` 算好带进来）。 */
    assumedCached?: number;
  }[],
  model: string = DEFAULT_PRICING_MODEL,
): CostBreakdown | null {
  const price = DEEPSEEK_PEAK_PRICES[model];
  if (!price) return null;
  const offPeak = offPeakOf(price);

  const total: CostBreakdown = {
    cny: 0,
    peakCny: 0,
    offPeakCny: 0,
    peakTokens: 0,
    offPeakTokens: 0,
    cacheHit: 0,
    cacheMiss: 0,
    output: 0,
    assumedCachedTokens: 0,
  };

  for (const record of records) {
    const prompt = Number(record.promptTokens) || 0;
    const cached = Math.min(Number(record.cachedTokens) || 0, prompt);
    const output = Number(record.completionTokens) || 0;
    const peak = isPeakHour(record.ts);
    const cost = priceOf({ prompt, cached, output }, peak ? price : offPeak);

    total.cny += cost;
    total.cacheHit += cached;
    total.cacheMiss += Math.max(0, prompt - cached);
    total.output += output;
    total.assumedCachedTokens += Math.max(0, Number(record.assumedCached) || 0);
    if (peak) {
      total.peakCny += cost;
      total.peakTokens += prompt + output;
    } else {
      total.offPeakCny += cost;
      total.offPeakTokens += prompt + output;
    }
  }
  return total;
}

/**
 * 人民币金额 → 便于阅读的字符串。
 *
 * 不能直接用 `fmtNum`：折算出来的钱常常只有几分钱，两位小数会显示成 `¥0.00`——
 * 那等于说「不要钱」。所以按量级给小数位。
 *
 * 前端 `web/src/utils/format.ts` 的 `fmtCny` 是**唯一一处刻意的重复**，两边必须逐字
 * 一致（服务端不发格式化后的金额，但要能断言「该显示几位小数」）。改一处必须改
 * 另一处，两边测试都会红。
 */
export function formatCny(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '¥0';
  if (value >= 1) return `¥${value.toFixed(2)}`;
  if (value >= 0.01) return `¥${value.toFixed(3)}`;
  // 小于 1 分时给 2 位有效数字，避免显示成 ¥0.00
  return `¥${value.toPrecision(2)}`;
}

// ---------------------------------------------------------------- 缓存推算

/**
 * 哪些通道**不报**缓存明细：它们的缓存量不按 0 算，而是按「其他通道的实测平均」推算。
 *
 * 目前只有 Trae。证据（`private/docs/trae-recon.md` §18 的记录）：
 *
 *   「你好」   prompt_tokens=25472  cache_read_input_tokens=0  cache_creation_input_tokens=0
 *   「你是谁」 prompt_tokens=25628  cache_read_input_tokens=0  cache_creation_input_tokens=0
 *
 * 抓的是 Trae **自己的客户端**，同一个 conversation_id、25K 上下文连发两次，读和写都是 0；
 * 网关的 401 条 Trae 记录里也没有一条 `cached > 0`。上游那个 `provider_model_name` 是
 * `ep-20260825171921-hqq57` —— 火山引擎方舟的接入点，缓存统计在那一层没透出来。
 * 所以「Trae 一次都没命中」几乎肯定是**数据缺口**，不是事实。
 */
export const CACHE_ESTIMATED_PROVIDERS: readonly string[] = ['trae'];

/** 窗口里没有任何可对比的实测数据时的兜底比例（2026-11-13 用户定的原值）。 */
export const CACHE_ESTIMATE_FALLBACK_RATE = 0.98;

export interface CacheRateRow {
  provider: string;
  promptTokens?: number | null;
  cachedTokens?: number | null;
}

const isEstimated = (provider: string) => CACHE_ESTIMATED_PROVIDERS.includes(provider);

/**
 * 实测缓存命中率：`Σcached / Σprompt`，**按 token 加权**。
 *
 * 三条口径，错一条就会静默给出一个小数：
 *   1. 只算报了缓存的通道——要的是「别人测出来的平均水平」，不是把缺口算进去；
 *   2. 只算上游真的报了数的行（`cached !== null`）：`null` 是「没报」，按 0 计入
 *      分母会把平均压低；
 *   3. 按 token 加权，不是各通道算完再平均——否则 25 token 的请求和 2 亿 token 同权。
 *
 * 返回 `null` 表示窗口里没有可用数据（调用方用兜底比例）。
 */
export function measuredCacheHitRate(rows: readonly CacheRateRow[]): number | null {
  let cached = 0;
  let prompt = 0;
  for (const row of rows) {
    if (isEstimated(row.provider)) continue;
    if (row.cachedTokens === null || row.cachedTokens === undefined) continue;
    const p = Math.max(0, Number(row.promptTokens) || 0);
    const c = Math.min(Math.max(0, Number(row.cachedTokens) || 0), p);
    prompt += p;
    cached += c;
  }
  if (prompt <= 0) return null;
  return cached / prompt;
}

/**
 * 这条记录该按多少缓存算（计价和「推算缓存」列共用这一条规则）。
 *
 * - 上游报了正数 → **用上游的**（真数据永远优先，推算只为补缺口）；
 * - 该通道在不报缓存的名单里 → `prompt × 实测平均率`（没有实测数据时用兜底 98%）；
 * - 其他通道报了 0 → 就是 0（那是实测的「没命中」）。
 *
 * 返回值里的 `assumed` 是「其中多少是推算出来的」，调用方必须把它汇总上报——
 * **不标出来的推算就是假数据**。
 */
export function cachedForPricing(
  provider: string,
  promptTokens: number,
  reportedCached: number | null | undefined,
  rate: number | null = null,
): { cached: number; assumed: number } {
  const prompt = Math.max(0, Number(promptTokens) || 0);
  const reported = Number(reportedCached) || 0;
  if (reported > 0) return { cached: Math.min(reported, prompt), assumed: 0 };
  if (!isEstimated(provider)) return { cached: 0, assumed: 0 };
  const useRate = rate === null ? CACHE_ESTIMATE_FALLBACK_RATE : rate;
  const assumed = Math.min(prompt, Math.floor(prompt * useRate));
  return { cached: assumed, assumed };
}

