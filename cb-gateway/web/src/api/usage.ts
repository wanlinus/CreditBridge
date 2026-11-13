import { api } from './client';

export interface DimMap {
  [key: string]: { tokens: number; requests: number; credits: number };
}

export interface DailyBucket {
  date: string;
  tokens: number;
  requests: number;
  credits: number;
  byModel: DimMap;
  byAccount: DimMap;
  byProvider: DimMap;
}

interface UsageTotals {
  requests: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  credits: number;
  statusCounts: Record<string, number>;
}

interface EstimatedCost {
  cny: number;
  peakCny: number;
  offPeakCny: number;
  peakTokens: number;
  offPeakTokens: number;
  cacheHit: number;
  cacheMiss: number;
  output: number;
}

interface TodayTotals extends UsageTotals {
  medianDurationMs: number | null;
  cost: EstimatedCost | null;
}

interface ModelBucket {
  model: string;
  requests: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  credits: number;
  creditsPerKToken: number | null;
}

interface AccountBucket {
  account: string;
  requests: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  credits: number;
}

export interface UsageRecord {
  ts: number;
  provider: string | null;
  account: string | null;
  model: string | null;
  effort: string | null;
  credit: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  durationMs: number;
  status: number | null;
}

export interface UsageResponse {
  totals: UsageTotals;
  today: TodayTotals;
  daily: DailyBucket[];
  byModel: ModelBucket[];
  byAccount: AccountBucket[];
  todayByAccount: AccountBucket[];
  recent: UsageRecord[];
  generatedAt: string;
}

export function getUsage(): Promise<UsageResponse> {
  return api.get<UsageResponse>('/api/usage');
}

export function getAccountUsage(id: string): Promise<UsageResponse> {
  return api.get<UsageResponse>(`/api/accounts/${encodeURIComponent(id)}/usage`);
}
