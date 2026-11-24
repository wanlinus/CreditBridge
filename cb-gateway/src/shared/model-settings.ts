// 每个模型的网关侧设置：上下文窗口、最大输出、缺省思考档。**唯一事实源**，存
// `model_setting` 表，改完立刻生效。
//
// 键是 `<idPrefix>/<上游模型 id>` 而不是对外 id：上下文窗口是**模型**的属性，不是
// 账号的——两个号挂同一个模型该是同一个值，加号删号不该把设置弄丢。
//
// 只在网关存一份，插件退化成「照抄」。早先 profile 和 config.json 各存一份，
// `min(两个)` 就是为擦那个屁股加的。

import {
  deleteModelSetting,
  listModelSettings,
  putModelSetting,
} from '../store/settings.ts';
import type { ModelInfo } from '../types.ts';

/** 上下文窗口的合法区间。低于它对话没意义，高于它上游会拒。 */
export const MIN_CONTEXT = 8000;
export const MAX_CONTEXT = 2000000;
/** 最大输出。 */
export const MIN_OUTPUT = 256;

/**
 * 上游没报档位表时的兜底。**必须和插件以前那份逐项一致**（只是把 `none` 写成 `off`）：
 *
 * - `off` 是「关闭思考」，用户最常用的就是它和最低档；
 * - `xhigh` 是这份表里最高的档。它已经被真实请求打过（WorkBuddy / Trae 都收过），
 *   而 `max` 没有——Trae 会把它映射成 `extra_high`，但 WorkBuddy 是**原样透传**，
 *   上游认不认 `max` 没人验证过。所以「最高档」取 `xhigh`，不取 `max`。
 *
 * 只有 Loomy / Qoder 会自己报逐模型的档位表，它们报什么就用什么。
 */
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

/** `<prefix>/<上游模型 id>`。 */
export function settingKey(prefix: string, modelId: string): string {
  return `${prefix}/${modelId}`;
}

// 内存索引：`settingOf()` 原先每次都全表读再 find，而 `/api/models` 是「账号数 ×
// 模型数」次调用（180 次实测 26ms），插件还每 15 秒拉一次。写路径 `writeSetting()`
// 负责失效；不做 TTL——模型设置只能在 `/models` 页改，没有绕过网关改库的场景。
//
// 返回副本，而且要**逐个再拷一层**：只写 `{ ...settingsIndex() }` 不够——那只拷外层，
// 内层 `ModelSetting` 还是缓存本体，调用方改一个字段就污染了缓存，而错误不会报出来。

/** `settingKey` → 设置。`null` = 还没建或已失效。 */
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

/** 全部设置，按 `settingKey` 索引。没配、类型不对都当「没有设置」。 */
export function allSettings(): Record<string, ModelSetting> {
  // 逐个再拷一层：外层的 `{ ...}` 只挡住「换掉整个 entry」，挡不住
  // 「改某个 entry 里的字段」——而那正是实际会被写错的那种（见上方注释）。
  const out: Record<string, ModelSetting> = {};
  for (const [key, setting] of Object.entries(settingsIndex())) out[key] = { ...setting };
  return out;
}

/** 一个模型的设置；没有就是 `undefined`（调用方据此区分「配过」和「没配」）。 */
export function settingOf(prefix: string, modelId: string): ModelSetting | undefined {
  const hit = settingsIndex()[settingKey(prefix, modelId)];
  // 同样给副本：调用方拿到的是「一份设置」，不是缓存本体。
  return hit ? { ...hit } : undefined;
}

/**
 * 落库一份设置。`undefined` / 空串的字段**不写**（留 `null` = 跟随上游）——表里要能
 * 看出「哪些是显式配的」，一堆无意义的数字只会越来越吵。全部清空就删掉那一行。
 *
 * @returns 该模型落库后的设置（可能为空对象 = 全部恢复默认）
 */
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
  // 落库之后立刻失效索引：下一个 `settingOf()` 会重新读。
  // 漏了这一步的表现是「保存成功但界面数字不变」，而且只有重启才恢复。
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

/**
 * 一个模型实际提供的思考档位。上游报了就用上游的，没报用 `FALLBACK_EFFORTS`。
 *
 * 上游的 `none` 一律归一成 `off`（DSH 的那一档叫 `off`）：早先这个映射写在前端/
 * 插件里，于是「网关报 none、profile 写 off」两条口径各改各的；现在只在网关这一处做。
 */
export function effortsOf(model: Pick<ModelInfo, 'reasoning' | 'reasoningEfforts'>): string[] {
  if (model.reasoning !== true) return [];
  const raw = Array.isArray(model.reasoningEfforts) ? model.reasoningEfforts : [];
  const cleaned = raw
    .map((level) => String(level ?? '').trim().toLowerCase())
    .filter(Boolean)
    .map((level) => (level === 'none' ? 'off' : level));
  const unique = [...new Set(cleaned)];
  // 只剩 `off` 的档位表等于「没法思考」，退回兜底（上游把 `off` 报出来通常意味着
  // 它只支持关，这点由 `reasoning` 字段判断，不该由档位表反推）。
  if (unique.length === 0 || unique.every((level) => level === 'off')) return [...FALLBACK_EFFORTS];
  return unique;
}

/**
 * 档位的**升序**阶梯，和 DSH 的 `THINKING_LEVELS` 一致。
 *
 * 判定「最高档」必须按这张表，不能按上游数组的顺序取最后一个：Qoder 的
 * `thinking_config.efforts` 是**降序**下发的（实测 `["xhigh","high","low"]`），
 * 取最后一个会得到 `low`——一个「默认档比用户手动选的最低档还低」的静默错误。
 */
const EFFORT_LADDER: readonly string[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** 档位表里最高的那一档，跳过 `off`。**「默认打开思考」就是这个**。 */
export function highestEffort(efforts: readonly string[]): string | null {
  let best: string | null = null;
  let bestRank = -1;
  for (const level of efforts) {
    if (!level || level === 'off') continue;
    const rank = EFFORT_LADDER.indexOf(level);
    // 表里没有的档（上游自造的名字）按「排在已知档之后、但小于 max」处理：
    // 认不出来就宁可不用它，也不要把它当最高档写出去。
    const score = rank >= 0 ? rank : EFFORT_LADDER.length - 1;
    if (score > bestRank) {
      bestRank = score;
      best = level;
    }
  }
  return best;
}

/**
 * 从最大窗口推一组可选尺寸：一半 / 四分之三 / 全部。
 *
 * 给**上游没提供档位表**的通道用（Qoder 的 CLI 名单、Loomy 的模型接口都只有上限）。
 * 为什么不硬编一套 `64K/128K/256K`：各家上限差一个数量级，固定档位会给出这个模型
 * 根本用不了的数。按比例推至少保证「三个档都在能力范围内」。
 *
 * 取 1000 的整数倍（已经是整数倍的保留），免得下拉里出现 `981504` 这种怪数。
 */
export function contextOptions(max: number): number[] {
  if (!Number.isFinite(max) || max <= 0) return [];
  const round = (value: number) => (Number.isInteger(value) && value % 1000 === 0 ? value : Math.round(value / 1000) * 1000);
  const values = [round(max * 0.5), round(max * 0.75), max].filter((value) => Number.isFinite(value) && value > 0);
  return [...new Set(values)].sort((a, b) => a - b);
}

/**
 * 上下文窗口的**缺省值**：这个模型允许的最大尺寸。
 *
 * 优先取档位表的最大值，没有档位表就用上游报的 `context_length`（各通道本来就是按
 * 最大值报的，见 `applyModelSettings` 的注释）。
 *
 * 为什么不用 `lengths.default`：那是上游**客户端选择器的默认档**，可能小于它自己
 * 支持的上限（WorkBuddy 的 `defaultLength` 与 `supportedLengths` 是两件事）。DSH
 * 拿 `contextWindow` 规划压缩，取小值会让它提前压缩、白白丢掉上下文——用户要的是
 * 「能放多少就放多少」。
 */
export function maxContextOf(
  lengths: { default?: number; options?: number[] } | null | undefined,
  fallback: number,
): number {
  const options = lengths && Array.isArray(lengths.options) ? lengths.options.filter((n) => Number.isFinite(n)) : [];
  if (options.length === 0) return fallback;
  return Math.max(...options);
}

/**
 * 这个模型生效的缺省思考档：用户配过就用配的，没配就用最高的那一档。
 * 不思考的模型返回 `null`。
 */
export function effectiveEffort(
  prefix: string,
  model: Pick<ModelInfo, 'id' | 'reasoning' | 'reasoningEfforts'>,
): string | null {
  const efforts = effortsOf(model);
  if (efforts.length === 0) return null;
  const configured = settingOf(prefix, model.id)?.reasoningEffort;
  if (typeof configured === 'string' && configured !== '') {
    // 配的档不在档位表里时**不信它**：写进去的档上游不认只会静默按默认跑，
    // 人还以为调过了（`test/profile-models.mjs` 钉的就是这条）。
    return efforts.includes(configured) ? configured : highestEffort(efforts);
  }
  return highestEffort(efforts);
}

/**
 * 把一个上游模型套上网关设置，得到**对外报的那一份**。
 *
 * 覆盖只发生在数值字段上：`context_length` / `max_output_tokens`。`reasoningEfforts`
 * 和 `defaultReasoningEffort` 是**推导**出来的（不再是用户手写的），所以每次都重算。
 *
 * 顺带把「这个模型的缺省档」记进内存缓存——聊天路径上要它，但那里调 `modelsOf()`
 * 可能打上游（一次 HTTP），不能每个请求算一次。
 */
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
    // 不思考的模型要把这两个字段**去掉**：留着 `reasoning: true` 会让 DSH 以为
    // 有档位可选，而实际上一个都没有。
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

/**
 * 聊天时要用的缺省思考档。`null` = 这个模型不该思考（别注入）。
 *
 * 三种来源，按可靠度排：
 *   1. 缓存（由 `/api/models` 的构建过程填，插件每 15 秒刷一次）；
 *   2. 用户在网关显式配的档（保存时已经校验过档位表，可以直接信）；
 *   3. 都没有 → 不注入。
 *
 * 第 3 种发生在「网关刚启动、还没人拉过模型列表」的头十几秒。此时宁可不注入，
 * 也不要塞一个没校验过的档——那正是「上游不认、静默按默认跑」的来源。
 */
export function defaultEffortFor(prefix: string, modelId: string): string | null {
  const hit = effortCache.get(settingKey(prefix, modelId));
  if (hit && Date.now() - hit.at < EFFORT_TTL_MS) return hit.effort;
  const configured = settingOf(prefix, modelId)?.reasoningEffort;
  return typeof configured === 'string' && configured !== '' ? configured : null;
}
