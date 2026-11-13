import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './shared/paths.ts';
import { log } from './logger.ts';
import { DEFAULT_PRICING_MODEL, estimateCostOfRecords } from './shared/deepseek-pricing.ts';

const USAGE_PATH = path.join(DATA_DIR, 'usage.jsonl');

function recordUsage(entry: any) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(USAGE_PATH, JSON.stringify(entry) + '\n');
  } catch (error: any) {
    log(`usage record failed: ${error.message}`);
  }
}

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
    effort,
    credit: typeof usage?.credit === 'number' ? usage.credit : null,
    promptTokens: usage?.prompt_tokens ?? null,
    completionTokens: usage?.completion_tokens ?? null,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
    totalTokens: usage?.total_tokens ?? null,
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? null,
    cacheWriteTokens: usage?.prompt_tokens_details?.cache_write_tokens ?? null,
    durationMs: Date.now() - started,
    status,
  });
}

const MAX_READ_BYTES = 64 * 1024 * 1024;

function readUsageRecords(): any[] {
  try {
    const stat = fs.statSync(USAGE_PATH);
    const oversized = stat.size > MAX_READ_BYTES;
    let text: string;
    if (oversized) {
      const start = stat.size - MAX_READ_BYTES;
      const buffer = Buffer.alloc(MAX_READ_BYTES);
      const fd = fs.openSync(USAGE_PATH, 'r');
      try {
        fs.readSync(fd, buffer, 0, MAX_READ_BYTES, start);
      } finally {
        fs.closeSync(fd);
      }
      text = buffer.toString('utf8');
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
      if (!warnedOversized) {
        warnedOversized = true;
        log(`账本超过 ${MAX_READ_BYTES / 1024 / 1024}MB，只统计最近这一段（更早的记录不在面板里）`);
      }
    } else {
      text = fs.readFileSync(USAGE_PATH, 'utf8');
    }
    const records: any[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record && typeof record.ts === 'number') records.push(record);
      } catch {
      }
    }
    return records;
  } catch {
    return [];
  }
}

let recordsCache: { size: number; mtimeMs: number; records: any[] } | null = null;
let warnedOversized = false;

function usageRecords(): any[] {
  let stat;
  try {
    stat = fs.statSync(USAGE_PATH);
  } catch {
    recordsCache = null;
    return [];
  }
  if (recordsCache && recordsCache.size === stat.size && recordsCache.mtimeMs === stat.mtimeMs) {
    return recordsCache.records;
  }
  const records = readUsageRecords();
  recordsCache = { size: stat.size, mtimeMs: stat.mtimeMs, records };
  return records;
}

const LEGACY_PROVIDER = 'workbuddy';

export async function usageSummary(options: { provider?: string | null; account?: string | null } = {}) {
  const provider = options.provider || null;
  const account = options.account || null;
  const records = usageRecords().filter((record) => {
    const recordProvider = typeof record.provider === 'string' ? record.provider : LEGACY_PROVIDER;
    if (provider && recordProvider !== provider) return false;
    if (account && record.account !== account) return false;
    return true;
  });
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const DAYS = 14;
  const dayKeys: string[] = [];
  const dayBuckets = new Map<string, {
    date: string;
    credits: number;
    tokens: number;
    requests: number;
    byModel: Map<string, { tokens: number; completionTokens: number; requests: number; credits: number }>;
    byAccount: Map<string, { tokens: number; completionTokens: number; requests: number; credits: number }>;
    byProvider: Map<string, { tokens: number; completionTokens: number; requests: number; credits: number }>;
  }>();
  for (let i = DAYS - 1; i >= 0; i -= 1) {
    const day = new Date(startOfToday.getTime() - i * 86400000);
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
  const oldestDay = startOfToday.getTime() - (DAYS - 1) * 86400000;
  const localDayKey = (ts: number) => {
    const day = new Date(ts);
    return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  };

  const emptyTally = () => ({
    requests: 0,
    credits: 0,
    tokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    statusCounts: {} as Record<string, number>,
  });
  const totals = emptyTally();
  const today = emptyTally();
  const todayDurations: number[] = [];
  const todayForPricing: {
    ts: number;
    promptTokens: number;
    cachedTokens: number;
    completionTokens: number;
  }[] = [];
  type Bucket = { tokens: number; completionTokens: number; requests: number; credits: number };
  const byModel = new Map<string, Bucket & { model: string; promptTokens: number; completionTokens: number }>();
  const byAccount = new Map<string, {
    account: string;
    requests: number;
    tokens: number;
    promptTokens: number;
    completionTokens: number;
    credits: number;
  }>();
  const todayByAccount = new Map<string, {
    account: string;
    requests: number;
    tokens: number;
    promptTokens: number;
    completionTokens: number;
    credits: number;
  }>();
  for (const record of records) {
    const credit = typeof record.credit === 'number' ? record.credit : 0;
    const promptTokens = Number(record.promptTokens) || 0;
    const completionTokens = Number(record.completionTokens) || 0;
    const tokens = promptTokens + completionTokens;
    const cachedTokens = Number(record.cachedTokens) || 0;
    const reasoningTokens = Number(record.reasoningTokens) || 0;
    totals.requests += 1;
    totals.credits += credit;
    totals.tokens += tokens;
    totals.promptTokens += promptTokens;
    totals.completionTokens += completionTokens;
    totals.cachedTokens += cachedTokens;
    totals.reasoningTokens += reasoningTokens;
    const statusKey = String(record.status ?? '(none)');
    totals.statusCounts[statusKey] = (totals.statusCounts[statusKey] ?? 0) + 1;
    const accountKey = typeof record.account === 'string' && record.account !== '' ? record.account : '(未标注)';
    const accountBucket = byAccount.get(accountKey) || {
      account: accountKey,
      requests: 0,
      tokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      credits: 0,
    };
    accountBucket.requests += 1;
    accountBucket.tokens += tokens;
    accountBucket.promptTokens += promptTokens;
    accountBucket.completionTokens += completionTokens;
    accountBucket.credits += credit;
    byAccount.set(accountKey, accountBucket);
    if (record.ts >= startOfToday.getTime()) {
      const todayBucket = todayByAccount.get(accountKey) || {
        account: accountKey,
        requests: 0,
        tokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        credits: 0,
      };
      todayBucket.requests += 1;
      todayBucket.tokens += tokens;
      todayBucket.promptTokens += promptTokens;
      todayBucket.completionTokens += completionTokens;
      todayBucket.credits += credit;
      todayByAccount.set(accountKey, todayBucket);
      today.requests += 1;
      today.credits += credit;
      today.tokens += tokens;
      today.promptTokens += promptTokens;
      today.completionTokens += completionTokens;
      today.cachedTokens += cachedTokens;
      today.reasoningTokens += reasoningTokens;
      today.statusCounts[statusKey] = (today.statusCounts[statusKey] ?? 0) + 1;
      if (typeof record.durationMs === 'number' && Number.isFinite(record.durationMs)) {
        todayDurations.push(record.durationMs);
      }
      todayForPricing.push({ ts: record.ts, promptTokens, cachedTokens, completionTokens });
    }
    if (record.ts >= oldestDay) {
      const bucket = dayBuckets.get(localDayKey(record.ts));
      if (bucket) {
        bucket.credits += credit;
        bucket.tokens += tokens;
        bucket.requests += 1;
        const modelKey = typeof record.model === 'string' && record.model !== '' ? record.model : '(未标注)';
        const accountKey = typeof record.account === 'string' && record.account !== '' ? record.account : '(未标注)';
        const providerKey = typeof record.provider === 'string' && record.provider !== '' ? record.provider : LEGACY_PROVIDER;
        for (const [dimMap, dimKey] of [[bucket.byModel, modelKey], [bucket.byAccount, accountKey], [bucket.byProvider, providerKey]] as [Map<string, Bucket>, string][]) {
          const sub = dimMap.get(dimKey) || { tokens: 0, completionTokens: 0, requests: 0, credits: 0 };
          sub.tokens += tokens;
          sub.completionTokens += completionTokens;
          sub.credits += credit;
          sub.requests += 1;
          dimMap.set(dimKey, sub);
        }
      }
    }
    const key = record.model || '(unknown)';
    const bucket = byModel.get(key) || {
      model: key,
      requests: 0,
      tokens: 0,
      credits: 0,
      promptTokens: 0,
      completionTokens: 0,
    };
    bucket.requests += 1;
    bucket.tokens += tokens;
    bucket.credits += credit;
    bucket.promptTokens += promptTokens;
    bucket.completionTokens += completionTokens;
    byModel.set(key, bucket);
  }
  const round = (n: any) => Math.round(n * 10000) / 10000;
  const models = [...byModel.values()]
    .map((m) => ({
      ...m,
      credits: round(m.credits),
      creditsPerKToken: m.tokens > 0 && m.credits > 0 ? round((m.credits / m.tokens) * 1000) : null,
    }))
    .sort((a, b) => b.tokens - a.tokens);

  return {
    totals: { ...totals, credits: round(totals.credits) },
    today: {
      ...today,
      credits: round(today.credits),
      medianDurationMs: todayDurations.length
        ? [...todayDurations].sort((a, b) => a - b)[Math.floor(todayDurations.length / 2)]
        : null,
      cost: estimateCostOfRecords(todayForPricing, DEFAULT_PRICING_MODEL),
    },
    daily: dayKeys.map((key) => {
      const bucket = dayBuckets.get(key)!;
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
    byAccount: [...byAccount.values()]
      .map((item) => ({ ...item, credits: round(item.credits) }))
      .sort((a, b) => b.tokens - a.tokens),
    todayByAccount: [...todayByAccount.values()]
      .map((item) => ({ ...item, credits: round(item.credits) }))
      .sort((a, b) => b.tokens - a.tokens),
    recent: (() => {
      const ok = records.filter((record) => record.status === 200).slice(-10);
      const bad = records.filter((record) => record.status !== 200).slice(-10);
      return [...ok, ...bad].sort((a, b) => b.ts - a.ts).slice(0, 20);
    })(),
    generatedAt: new Date().toISOString(),
  };
}
