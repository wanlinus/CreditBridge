// DeepSeek 官方价目（人民币），给账本里的 token 估一个「按 DeepSeek 价折合多少钱」。
// **这不是账单**：这些 token 花在四家上游上，不走 DeepSeek 的 API，它只是参照系。
// 价目来源 https://api-docs.deepseek.com/zh-cn/quick_start/pricing/（2026-11-13 抓取，元/百万 tokens）。

import { beijingHour, beijingWeekday } from './clock.ts';

/** 每 1M token 的人民币价格。 */
export interface ModelPrice {
  inputCacheHit: number;
  inputCacheMiss: number;
  output: number;
}

/** 一小时、一美元的千分之一这类中间量都按「元」算，不做四舍五入。 */
export const CURRENCY = 'CNY';

/** DeepSeek 官方价目（**高峰时段**，元 / 1M token）：缓存命中 0.04、未命中 2、输出 8。空闲价 = 高峰价 ÷ 2。 */
export const DEEPSEEK_PEAK_PRICES: Record<string, ModelPrice> = {
  // 官方模型名就是 `deepseek-flash`（旧的 `deepseek-v4-flash` 已退役，仍按这个价收）
  'deepseek-flash': { inputCacheHit: 0.04, inputCacheMiss: 2, output: 8 },
};

/** 算价用的模型。只有 flash 一档——账本里所有模型都按它折算，不按模型分档。 */
export const DEFAULT_PRICING_MODEL = 'deepseek-flash';

/**
 * 这个时刻是不是**高峰时段**（北京时间周一至周五 9:00-12:00、14:00-18:00，左闭右开）。
 *
 * **「北京时间」是业务规则，不是运行环境属性**——换算在 `clock.ts` 里，不看进程 `TZ`。
 * 2026-11-25 踩到：本地 UTC+8、CI 是 UTC，按本地时间判断会让峰谷全反。
 */
export function isPeakHour(at: number = Date.now()): boolean {
  const weekday = beijingWeekday(at);
  if (weekday === 0 || weekday === 6) return false;
  const hour = beijingHour(at);
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
  cacheHit: number;
  /** 缓存未命中输入 token 数（`prompt − cached`）。 */
  cacheMiss: number;
  output: number;
  /** `cacheHit` 里有多少是**假定**的。界面必须能看见它：不标出来的假定就是假数据。 */
  assumedCachedTokens: number;
}

/** 把一批 token 按给定单价算成元。**缓存是 `prompt` 的子集，要减不能加**——命中价 0.04、未命中 2，价差 50 倍，加成 `prompt + cached` 会把费用放大一倍。 */
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

/** 把一批**同属一个时段**的 token 折算成元。生产路径不用它（生产用 `estimateCostOfRecords` 逐条判峰谷），留着给 `test:deepseek-pricing` 当纯函数入口。 */
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
    // 单条记录这一层不做假定：假定是按通道的，由 `cachedForPricing()` 在调用方算好再传进来。
    assumedCachedTokens: 0,
  };
}

/** 把**多条记录**按各自的时间戳分别计价后汇总——这是仪表真正用的入口，跨小时的用量里既有高峰也有空闲，统一按一个价算会失真一倍。 */
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

/** 人民币金额 → 便于阅读的字符串。折算出来的钱常常只有几分钱，两位小数会显示成 `¥0.00`（等于说不要钱），所以按量级给小数位。 */
export function formatCny(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '¥0';
  if (value >= 1) return `¥${value.toFixed(2)}`;
  if (value >= 0.01) return `¥${value.toFixed(3)}`;
  // 小于 1 分时给 2 位有效数字，避免显示成 ¥0.00
  return `¥${value.toPrecision(2)}`;
}

// ---------------------------------------------------------------- 缓存推算

/** 哪些通道**不报**缓存明细：它们的缓存量按「其他通道的实测平均」推算而不是 0。目前只有 Trae——抓它自己客户端 25K 上下文连发两次、读和写都是 0，是数据缺口不是事实（`private/docs/protocols/trae.md` §18）。 */
export const CACHE_ESTIMATED_PROVIDERS: readonly string[] = ['trae'];

/** 窗口里没有任何可对比的实测数据时的兜底比例（2026-11-13 用户定的原值）。 */
export const CACHE_ESTIMATE_FALLBACK_RATE = 0.98;

export interface CacheRateRow {
  provider: string;
  promptTokens?: number | null;
  cachedTokens?: number | null;
}

const isEstimated = (provider: string) => CACHE_ESTIMATED_PROVIDERS.includes(provider);

/** 实测缓存命中率 `Σcached / Σprompt`，**按 token 加权**。只算报了缓存的通道、只算上游真报了数的行（`null` 是「没报」，按 0 进分母会把平均压低）。返回 `null` 表示窗口里没有可用数据。 */
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

/** 这条记录该按多少缓存算：上游报了正数就用上游的（真数据优先），不报缓存的通道按 `prompt × 实测率`（无实测用兜底 98%），其他通道报了 0 就是实测没命中。返回值里的 `assumed` 必须上报——不标出来的推算就是假数据。 */
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
