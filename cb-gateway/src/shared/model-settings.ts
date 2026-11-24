// 每个模型的网关侧设置：上下文窗口、最大输出、缺省思考档。**唯一事实源**，存 `model_setting` 表。
// 键是 `<idPrefix>/<上游模型 id>` 而不是对外 id：上下文窗口是**模型**的属性，加号删号不该把设置弄丢。
// 只在网关存一份，插件退化成「照抄」——早先 profile 和 config.json 各存一份，`min(两个)` 就是为擦那个屁股加的。

import {
  deleteModelSetting,
  listModelSettings,
  putModelSetting,
} from '../store/settings.ts';
import type { ModelInfo } from '../types.ts';

/** 上下文窗口的合法区间。低于它对话没意义，高于它上游会拒。 */
export const MIN_CONTEXT = 8000;
export const MAX_CONTEXT = 2000000;
export const MIN_OUTPUT = 256;

/** 上游没报档位表时的兜底，**必须和插件以前那份逐项一致**（只是把 `none` 写成 `off`）。最高档取 `xhigh` 不取 `max`：`xhigh` 被真实请求打过，而 WorkBuddy 对 `max` 是原样透传、上游认不认没人验证过。 */
export const FALLBACK_EFFORTS: readonly string[] = ['off', 'low', 'medium', 'high', 'xhigh'];

/** 一个模型的可调设置。字段缺省 = 「跟随上游」。 */
export interface ModelSetting {
  /** 上下文窗口。缺省 = 上游报的 `context_length`。 */
  contextWindow?: number;
  /** 最大输出。缺省 = 上游报的 `max_output_tokens`。 */
  maxTokens?: number;
  /** 缺省思考档。缺省 = 该模型档位表里最高的那一档（见 `highestEffort`）。 */
  reasoningEffort?: string;
}

export function settingKey(prefix: string, modelId: string): string {
  return `${prefix}/${modelId}`;
}

// 内存索引：`settingOf()` 原先每次都全表读再 find，而 `/api/models` 是「账号数 × 模型数」次调用
// （180 次实测 26ms），插件还每 15 秒拉一次。不做 TTL——设置只能在 `/models` 页改。
// 返回副本要**逐个再拷一层**：只写 `{ ...settingsIndex() }` 只拷外层，内层还是缓存本体，调用方改一个字段就污染了缓存且不报错。

let settingsCache: Record<string, ModelSetting> | null = null;

function buildSettingsIndex(): Record<string, ModelSetting> {
  const out: Record<string, ModelSetting> = {};
  for (const row of listModelSettings()) {
    // 只把**显式配过的**字段放进来：`null` 是「跟随上游」，不是「设成 0」。
    const setting: ModelSetting = {};
    if (row.contextWindow !== null) setting.contextWindow = row.contextWindow;
    if (row.maxTokens !== null) setting.maxTokens = row.maxTokens;
    if (row.reasoningEffort !== null) setting.reasoningEffort = row.reasoningEffort;
    out[settingKey(row.channelPrefix, row.modelId)] = setting;
  }
  return out;
}

function settingsIndex(): Record<string, ModelSetting> {
  if (settingsCache === null) settingsCache = buildSettingsIndex();
  return settingsCache;
}

/** 丢掉索引。**所有写路径都必须调它**，否则改了设置看不到效果。 */
function invalidateSettingsCache(): void {
  settingsCache = null;
}

export function allSettings(): Record<string, ModelSetting> {
  // 逐个再拷一层：外层的 `{ ...}` 挡不住「改某个 entry 里的字段」，而那正是实际会被写错的那种。
  const out: Record<string, ModelSetting> = {};
  for (const [key, setting] of Object.entries(settingsIndex())) out[key] = { ...setting };
  return out;
}

/** 一个模型的设置；没有就是 `undefined`（调用方据此区分「配过」和「没配」）。 */
export function settingOf(prefix: string, modelId: string): ModelSetting | undefined {
  const hit = settingsIndex()[settingKey(prefix, modelId)];
  return hit ? { ...hit } : undefined;
}

/** 落库一份设置。`undefined` / 空串的字段**不写**（留 `null` = 跟随上游），全部清空就删掉那一行。 */
export function writeSetting(prefix: string, modelId: string, patch: ModelSetting): ModelSetting {
  const next: ModelSetting = { ...(settingOf(prefix, modelId) ?? {}) };
  for (const field of ['contextWindow', 'maxTokens', 'reasoningEffort'] as const) {
    if (!(field in patch)) continue;
    const value = patch[field];
    if (value === undefined || value === null || value === '') delete next[field];
    else next[field] = value as never;
  }

  if (Object.keys(next).length === 0) {
    deleteModelSetting(prefix, modelId);
  } else {
    putModelSetting({
      channelPrefix: prefix,
      modelId,
      contextWindow: next.contextWindow ?? null,
      maxTokens: next.maxTokens ?? null,
      reasoningEffort: next.reasoningEffort ?? null,
    });
  }
  // 落库之后立刻失效索引。漏了这一步的表现是「保存成功但界面数字不变」，只有重启才恢复。
  invalidateSettingsCache();
  return next;
}

/** 校验一个数字字段，非法抛错（错误信息直接回给页面）。 */
export function assertNumber(modelId: string, field: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${modelId}：${field} 要是数字`);
  }
  const rounded = Math.round(value);
  if (rounded < min || rounded > max) {
    throw new Error(`${modelId}：${field} 超出范围（${min}..${max}）`);
  }
  return rounded;
}

// ---------------------------------------------------------------- 生效值

/** 一个模型实际提供的思考档位。上游报了就用上游的，没报用 `FALLBACK_EFFORTS`；上游的 `none` 一律归一成 `off`（DSH 那一档叫 `off`），归一化只在网关这一处做。 */
export function effortsOf(model: Pick<ModelInfo, 'reasoning' | 'reasoningEfforts'>): string[] {
  if (model.reasoning !== true) return [];
  const raw = Array.isArray(model.reasoningEfforts) ? model.reasoningEfforts : [];
  const cleaned = raw
    .map((level) => String(level ?? '').trim().toLowerCase())
    .filter(Boolean)
    .map((level) => (level === 'none' ? 'off' : level));
  const unique = [...new Set(cleaned)];
  // 只剩 `off` 的档位表等于「没法思考」，退回兜底——上游把 `off` 报出来通常意味着它只支持关。
  if (unique.length === 0 || unique.every((level) => level === 'off')) return [...FALLBACK_EFFORTS];
  return unique;
}

/** 档位的**升序**阶梯，和 DSH 的 `THINKING_LEVELS` 一致。判「最高档」必须按这张表，不能取上游数组最后一个：Qoder 的 `efforts` 是**降序**下发的（实测 `["xhigh","high","low"]`），取最后一个会得到 `low`。 */
const EFFORT_LADDER: readonly string[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** 档位表里最高的那一档，跳过 `off`。**「默认打开思考」就是这个**。 */
export function highestEffort(efforts: readonly string[]): string | null {
  let best: string | null = null;
  let bestRank = -1;
  for (const level of efforts) {
    if (!level || level === 'off') continue;
    const rank = EFFORT_LADDER.indexOf(level);
    // 表里没有的档（上游自造的名字）按「排在已知档之后、但小于 max」处理：认不出来就宁可不用它。
    const score = rank >= 0 ? rank : EFFORT_LADDER.length - 1;
    if (score > bestRank) {
      bestRank = score;
      best = level;
    }
  }
  return best;
}

/** 从最大窗口推一组可选尺寸：一半 / 四分之三 / 全部。给**上游没提供档位表**的通道用——硬编 `64K/128K/256K` 会给出这个模型根本用不了的数。取 1000 的整数倍，免得下拉里出现 `981504` 这种怪数。 */
export function contextOptions(max: number): number[] {
  if (!Number.isFinite(max) || max <= 0) return [];
  const round = (value: number) => (Number.isInteger(value) && value % 1000 === 0 ? value : Math.round(value / 1000) * 1000);
  const values = [round(max * 0.5), round(max * 0.75), max].filter((value) => Number.isFinite(value) && value > 0);
  return [...new Set(values)].sort((a, b) => a - b);
}

/** 上下文窗口的**缺省值**：这个模型允许的最大尺寸。不用 `lengths.default`——那是上游**客户端选择器的默认档**，可能小于它自己的上限；DSH 拿 `contextWindow` 规划压缩，取小值会提前压缩、白丢上下文。 */
export function maxContextOf(
  lengths: { default?: number; options?: number[] } | null | undefined,
  fallback: number,
): number {
  const options = lengths && Array.isArray(lengths.options) ? lengths.options.filter((n) => Number.isFinite(n)) : [];
  if (options.length === 0) return fallback;
  return Math.max(...options);
}

/** 这个模型生效的缺省思考档：用户配过就用配的，没配就用最高的那一档。不思考的模型返回 `null`。 */
export function effectiveEffort(
  prefix: string,
  model: Pick<ModelInfo, 'id' | 'reasoning' | 'reasoningEfforts'>,
): string | null {
  const efforts = effortsOf(model);
  if (efforts.length === 0) return null;
  const configured = settingOf(prefix, model.id)?.reasoningEffort;
  if (typeof configured === 'string' && configured !== '') {
    // 配的档不在档位表里时**不信它**：写进去的档上游不认只会静默按默认跑（`test/profile-models.mjs` 钉的就是这条）。
    return efforts.includes(configured) ? configured : highestEffort(efforts);
  }
  return highestEffort(efforts);
}

/** 把一个上游模型套上网关设置，得到**对外报的那一份**。覆盖只发生在 `context_length` / `max_output_tokens`，档位字段每次重算。 */
export function applyModelSettings(prefix: string, model: ModelInfo): ModelInfo {
  const setting = settingOf(prefix, model.id) ?? {};
  const contextWindow =
    typeof setting.contextWindow === 'number' ? setting.contextWindow : model.context_length;
  const maxTokens = typeof setting.maxTokens === 'number' ? setting.maxTokens : model.max_output_tokens;
  const efforts = effortsOf(model);
  const effort = effectiveEffort(prefix, model);

  const out: ModelInfo = { ...model, context_length: contextWindow, max_output_tokens: maxTokens };
  if (efforts.length > 0) {
    out.reasoning = true;
    out.reasoningEfforts = efforts;
    if (effort) out.defaultReasoningEffort = effort;
  } else {
    // 不思考的模型要把这两个字段**去掉**：留着 `reasoning: true` 会让 DSH 以为有档位可选，而实际一个都没有。
    delete out.reasoningEfforts;
    delete out.defaultReasoningEffort;
  }

  rememberEffort(prefix, model.id, effort);
  return out;
}

// ---------------------------------------------------------------- 聊天路径的档位缓存

/** 缓存时长。模型目录变化很慢，5 分钟足够；插件每 15 秒拉一次会不断刷新它。 */
const EFFORT_TTL_MS = 5 * 60 * 1000;
const effortCache = new Map<string, { at: number; effort: string | null }>();

/** `applyModelSettings` 顺手记一笔，供聊天路径取用。 */
function rememberEffort(prefix: string, modelId: string, effort: string | null): void {
  effortCache.set(settingKey(prefix, modelId), { at: Date.now(), effort });
}

/** 聊天时要用的缺省思考档。`null` = 这个模型不该思考（别注入）。缓存都没有时（刚启动头十几秒）**宁可不注入**，也不要塞一个没校验过的档。 */
export function defaultEffortFor(prefix: string, modelId: string): string | null {
  const hit = effortCache.get(settingKey(prefix, modelId));
  if (hit && Date.now() - hit.at < EFFORT_TTL_MS) return hit.effort;
  const configured = settingOf(prefix, modelId)?.reasoningEffort;
  return typeof configured === 'string' && configured !== '' ? configured : null;
}
