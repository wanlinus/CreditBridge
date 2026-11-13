export interface ModelPrice {
  inputCacheHit: number;
  inputCacheMiss: number;
  output: number;
}

export const CURRENCY = 'CNY';

export const DEEPSEEK_PEAK_PRICES: Record<string, ModelPrice> = {
  'deepseek-flash': { inputCacheHit: 0.04, inputCacheMiss: 2, output: 8 },
  'deepseek-v4-pro': { inputCacheHit: 0.3, inputCacheMiss: 9, output: 27 },
};

export const DEFAULT_PRICING_MODEL = 'deepseek-flash';

export function isPeakHour(at: number = Date.now()): boolean {
  const d = new Date(at);
  const day = d.getDay();
  if (day === 0 || day === 6) return false;
  const hour = d.getHours();
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

export interface CostBreakdown {
  cny: number;
  peakCny: number;
  offPeakCny: number;
  peakTokens: number;
  offPeakTokens: number;
  cacheHit: number;
  cacheMiss: number;
  output: number;
}

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

function offPeakOf(price: ModelPrice): ModelPrice {
  return {
    inputCacheHit: price.inputCacheHit / 2,
    inputCacheMiss: price.inputCacheMiss / 2,
    output: price.output / 2,
  };
}

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
  };
}

export function estimateCostOfRecords(
  records: { ts: number; promptTokens?: number | null; cachedTokens?: number | null; completionTokens?: number | null }[],
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

export function formatCny(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '¥0';
  if (value >= 1) return `¥${value.toFixed(2)}`;
  if (value >= 0.01) return `¥${value.toFixed(3)}`;
  return `¥${value.toPrecision(2)}`;
}
