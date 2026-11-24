/**
 * 账本（`GET /api/usage` 全局、`GET /api/accounts/:id/usage` 单账号，形状相同）。
 *
 * **主口径是 token 不是积分**：`tokens = promptTokens + completionTokens`，全部来自
 * 上游响应里的 `usage` 帧（网关自己不数——各家 tokenizer 不同，自己数的和账单对不上）。
 * 积分各家的叫法和重置规则都不同，加在一起没有意义。
 *
 * 三个坑：
 *  1. `daily` 恒 14 项、含零消耗日——别在图表里过滤掉零值，那会让正常的一天变空白。
 *  2. `cachedTokens` 是 `promptTokens` 的**子集**，不是增量。命中率是 `cached / prompt`，
 *     **绝不能** `prompt + cached`。
 *  3. `cachedTokens` 有大量历史行是 `null`（老版本没记），所以命中率是近期口径。
 */
import { api } from './client';

/** 某一天里某个维度分桶的形状。 */
export interface DimMap {
  [key: string]: { tokens: number; requests: number; credits: number };
}

export interface DailyBucket {
  /** `YYYY-MM-DD`（服务端本地日历日）。轴标签直接 `slice(5)`，不要过 `new Date()`。 */
  date: string;
  /** 当天总 token（输入 + 输出）。 */
  tokens: number;
  requests: number;
  /** 附属信息：只有部分通道报这个数。 */
  credits: number;
  /** key 是**上游模型名**（`deepseek-v4.1-flash`），不是带账号段的完整模型 id。 */
  byModel: DimMap;
  /** key 是账号 id（`wb-1`）。旧行没有账号字段的归 `(未标注)`。 */
  byAccount: DimMap;
  /** key 是**通道 id**（`workbuddy`），不是模型 id 前缀。 */
  byProvider: DimMap;
}

interface UsageTotals {
  requests: number;
  /** 输入 + 输出。 */
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  /**
   * 命中缓存的输入量，是 `promptTokens` 的**子集**。
   * 老行没有这个字段（不给 0 顶替——「不知道」和「确实是 0」不是一回事）。
   */
  cachedTokens: number;
  /** 推理输出的量，是 `completionTokens` 的**子集**。 */
  reasoningTokens: number;
  /** 附属信息：只有部分通道报。 */
  credits: number;
  /**
   * 按 HTTP 状态码计数（key 是状态码的字符串形式）。
   *
   * 算成功率时**必须排除 499**：那是客户端主动断开，不是故障——AI 编程场景下打断、
   * 工具超时重试都算它，实测占过当天请求的 67%。不排除的话这一栏会永远显示 31% 左右。
   */
  statusCounts: Record<string, number>;
}

/**
 * 按 DeepSeek 官方价目折合的人民币估算。
 *
 * **不是账单**：这些 token 花在 WorkBuddy/Trae/Qoder/Loomy 上，不走 DeepSeek 的 API。
 * 它只提供一个可感的参照系（「2 亿 token 大概值多少钱」）。
 *
 * **按每条记录自己的时间戳分峰谷计价再汇总**：官方高峰价是空闲价的 2 倍
 * （北京时间工作日 9-12、14-18 点为高峰），而一天的用量跨好几个小时，
 * 统一套一个价会把费用算成两倍或一半。
 *
 * 价目与规则见 `cb-gateway/src/shared/deepseek-pricing.ts`。
 */
interface EstimatedCost {  /** 合计（元）。 */
  cny: number;
  /** 其中高峰时段产生的。 */
  peakCny: number;
  /** 其中空闲时段产生的。 */
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
   * `cacheHit` 里有多少是**假定**的——上游不报缓存的通道，网关按
   * `ASSUMED_CACHE_HIT_BY_PROVIDER` 的比例折算（见 `shared/deepseek-pricing.ts`）。
   *
   * **界面必须显示它**：不标出来的假定就是假数据。
   */
  assumedCachedTokens: number;
}

/**
 * 缓存命中率的口径。**和账本里的 `cachedTokens` 不是一回事**，两个数会差很多。
 *
 * 有通道（目前是 Trae）从不报缓存明细：它的 `cached` 恒为 0，直接拿
 * `Σcached / Σprompt` 算会把整体从 99% 拉到 84%——那是数据缺口，不是事实。
 * 所以服务端给三个数：
 */
interface CacheHitStats {
  /** 排除「不报缓存的通道」之后的实测加权率。**界面显示这个**。没有可对比数据时是 `null`。 */
  rate: number | null;
  /** 旧口径：含那些通道（按 0 计）。留作对照，界面上只在脚注里提一句。 */
  measuredRate: number | null;
  /**
   * 生效的缓存量 = 上游原值 + 推算部分。
   *
   * 卡片上「省下 X」读这个——命中率已经排除了 Trae，省下的量也得是同一口径，
   * 否则「99.0%」配「省下 4.28 亿」（含 Trae 报 0 的原值）两个数对不上。
   */
  effectiveCachedTokens: number;
  /** 被推算出来的部分：哪些通道、占多少输入、按什么比例推的。 */
  estimated: {
    cachedTokens: number;
    promptTokens: number;
    rate: number;
    providers: string[];
  };
}

/** `today` 比 `totals` 多一个耗时分位数。 */
interface TodayTotals extends UsageTotals {
  /** 今天耗时的**中位数**（不是平均值——上游偶发卡顿会把均值拉得没有参考价值）。 */
  medianDurationMs: number | null;
  /** 按 DeepSeek 价目折合的费用估算；价目表里没有对应模型时为 `null`。 */
  cost: EstimatedCost | null;
  /** 缓存命中率（含推算口径）。卡片读 `cacheHit.rate`，别再拿 token 相除。 */
  cacheHit: CacheHitStats;
}

/** 账本里的模型聚合行。按 `tokens` 降序。 */
interface ModelBucket {
  model: string;
  requests: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  credits: number;
  /**
   * 每千 token 花了多少积分。只在**同时**有 token 和 credit 的模型上有值。
   * 它不再是「相对最便宜模型的倍率」——那套反推已经删掉（上游自己就有倍率）。
   */
  creditsPerKToken: number | null;
}

interface AccountBucket {
  account: string;
  requests: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  /**
   * 上游实测的缓存读取量（`promptTokens` 的子集）。
   *
   * 概览页用 `promptTokens - cachedTokens` 判断「这个账号今天有多少输入是全价算的」。
   * **不报缓存的通道（Trae）这里是 0**，消费方必须跳过它们——0 表示「上游没给这个数」，
   * 不是「它真的全未命中」。
   */
  cachedTokens: number;
  credits: number;
}

/** `usage_record` 表的一行（v4 之前是 `data/usage.jsonl` 的一行）。 */
export interface UsageRecord {
  ts: number;
  /** 通道 id。 */
  provider: string | null;
  account: string | null;
  model: string | null;
  effort: string | null;
  /**
   * 上游报的单次成本。**只要上游没报就是 `null`**，不是 0。
   * Trae 从来不报（它不回报单次积分），所以它这一列恒为空。
   */
  credit: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  durationMs: number;
  /**
   * HTTP 状态码。**`499` 是「客户端主动断开」**，不是故障——概览页的成功率要把它
   * 排除在外（AI 编程场景下打断/超时重试非常频繁）。
   */
  status: number | null;
}

export interface UsageResponse {
  /**
   * `totals` / `byModel` / `byAccount` 覆盖的时间窗（近 N 个本地日历日，含今天）。
   *
   * **不要在页面里写死天数**：网关改窗口时这里会跟着变，文案用 `window.days` 拼。
   */
  window: { days: number; since: number };
  totals: UsageTotals;
  today: TodayTotals;
  /** 恒 14 项，按日期升序，最后一项是今天。 */
  daily: DailyBucket[];
  byModel: ModelBucket[];
  byAccount: AccountBucket[];
  todayByAccount: AccountBucket[];
  /** 最近 20 条，新的在前。 */
  recent: UsageRecord[];
  /** ISO 时间串。 */
  generatedAt: string;
}

export function getUsage(): Promise<UsageResponse> {
  return api.get<UsageResponse>('/api/usage');
}

export function getAccountUsage(id: string): Promise<UsageResponse> {
  return api.get<UsageResponse>(`/api/accounts/${encodeURIComponent(id)}/usage`);
}

/**
 * 单日 24 小时视图的一个小时。
 *
 * `cost` 由**网关**算好（价目表和峰谷规则只在网关，前端复制一份必然对不上）。
 * `cost` 为 `null` 表示价目表里没有对应模型——正常不会发生（只按 flash 计价）。
 */
export interface HourlyBucket {
  /** 0–23，本地小时。 */
  hour: number;
  requests: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  /**
   * **推算缓存**：上游报了就照原值，不报缓存的通道（Trae）按这一天实测的平均命中率折算。
   *
   * 所以它**不再是 `promptTokens` 的子集实测值**：`prompt − cached` 不再等于"未命中输入"。
   * 界面标题必须写「推算缓存」。
   */
  cachedTokens: number;
  /** `cachedTokens` 里有多少是推算出来的（实测为 0）。 */
  assumedCachedTokens: number;
  credits: number;
  cost: EstimatedCost | null;
  /** 这一小时在不在官方峰时段（工作日 9-12 / 14-18）。用来给柱子上色。 */
  peak: boolean;
}

export interface HourlyResponse {
  /** `YYYY-MM-DD`，和请求里的一致。 */
  date: string;
  /** 0 = 周日 … 6 = 周六。 */
  weekday: number;
  /** 这一天有没有峰时段（工作日才有）。 */
  isPeakDay: boolean;
  /** **恒 24 项**，缺的小时补 0——前端不该自己补齐。 */
  hours: HourlyBucket[];
  totals: {
    requests: number;
    tokens: number;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    assumedCachedTokens: number;
    credits: number;
    cost: EstimatedCost | null;
  };
  generatedAt: string;
}

/**
 * 某一天的 24 小时用量。
 *
 * `date` 必须是 `YYYY-MM-DD`；未来日期网关回 400（`ApiError`），页面据此提示。
 */
export function getHourlyUsage(date: string, options: { account?: string | null } = {}): Promise<HourlyResponse> {
  const query = new URLSearchParams({ date });
  if (options.account) query.set('account', options.account);
  return api.get<HourlyResponse>(`/api/usage/hourly?${query.toString()}`);
}
