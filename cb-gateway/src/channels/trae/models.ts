// Trae 的模型目录：`POST /api/ide/v1/batch_get_detail_param`（约 725KB，缓存 10 分钟）。
//
// 每条 `config_info_list` 里带：
//   context_window_tokens  { dev, max }      默认上下文 / Max 模式下的上下文
//   model_detail_list      **两条**：`<id>__dev` 和 `<id>__max`，各带
//                          { max_tokens, prompt_max_tokens }（两者之和 = 该模式上下文）
//   display_config         { display_name, max_mode, model_capability, is_custom_model }
//   display_contact_config { access.identity_list, consumption_rate.rate }  ← 会员门槛 / 倍率
//
// ## 读 `solo_agent`，但对话请求发的是 `chat_v3`
//
// 这两个 function 各有一份**不同的**模型表（2026-11-10 实测）：
//
//   solo_agent  71 个模型   deepseek-v4.1-flash: dev=200000  max_tokens=32000  prompt_max=168000
//   chat_v3     59 个模型   deepseek-v4.1-flash: dev=116000  max_tokens=16000  prompt_max=100000
//
// 读 `solo_agent` 是故意的：它的数更宽且**实测站得住**（26 万 token 正常返回）。
// `chat_v3` 声明的 116000/16000 不是硬闸门，按它报会把能力白白砍半。
// **别"顺手统一"成 chat_v3**——那会让 DSH 提前压缩、单次请求反而更贵。
//
// ## 报 `max` 变体（1M）而不是 `dev`
//
// 模型必须在对话请求的**顶层**用 `config_name` + 带后缀的 `model_name`
// （`deepseek-v4.1-flash__max`）声明，塞进 `custom_model` 一律不生效。用裸名发时
// 服务端忽略模型、落到账号默认模型，23 万 token 就 4026——看着像「max 走不通」，
// 实际是「压根没选到那个模型」。实测 `__max` 吃下 49 万 token 正常返回。
//
// 所以 `maxContext`（通常 100 万）可以放心报。完整过程见 private/docs/trae-recon.md §12/§13。

import type { Account, CatalogModel, ModelInfo } from '../../types.ts';
import { contextOptions } from '../../shared/model-settings.ts';
import { TRAE_CHAT_BASE, traeHeaders } from './auth.ts';

/**
 * 取配置用的 function。**故意和对话请求的 `chat_v3` 不同**，原因见文件头——
 * 改这个常量前先读那段。
 */
const CONFIG_FUNCTION = 'solo_agent';
const CONFIG_TTL_MS = 10 * 60 * 1000;
/** 取不到 `context_window_tokens.dev` 时的兜底。 */
const DEFAULT_CONTEXT = 200000;

let logSink: any = null;
export function setTraeModelsLogger(fn: any) {
  logSink = fn;
}
function log(...args: unknown[]) {
  if (logSink) logSink(`[trae-models] ${args.join(' ')}`);
}

export type TraeModelConfig = {
  id: string;
  name: string;
  /** 默认上下文窗口（不带 Max）。 */
  contextWindow: number;
  /** `contextWindow` 是猜的（上游没给 `context_window_tokens.dev`，落了默认值）。 */
  contextEstimated?: boolean;
  /** 开了 Max 模式时的窗口，只用于展示/排查，不报给 DSH。 */
  maxContext: number | null;
  maxTokens: number;
  /** Max 变体的输出上限（`__max` 的 `max_tokens`，一般是 dev 的两倍）。没有 Max 为 null。 */
  maxTokensMax: number | null;
  /**
   * `model_detail_list` 里两个变体的真实名字（`deepseek-v4.1-flash__dev` / `__max`）。
   *
   * **这两个字段是 Trae 认模型的唯一钥匙**：对话请求必须在**顶层**发
   * `config_name` + `model_name`，且 `model_name` 带后缀；发裸的不行
   * （`4023 model is unknown`），不带 `config_name` 则服务端忽略模型、一律用账号
   * 默认模型（表现是「所有模型都答豆包」）。
   */
  devModelName: string | null;
  maxModelName: string | null;
  /** 上游倍率，0.78 就是界面上的 `0.78x`；取不到为 null。 */
  rate: number | null;
  reasoning: boolean;
  /**
   * 支不支持**图像输入**（`display_config.multimodal`）。
   *
   * 交叉验证过：它与 `display_contact_config` 里的 `multimodal.enable` 17/17 一致，
   * 所以取前者（不用再解那串 JSON）。
   */
  multimodal: boolean;
};

/**
 * 这个模型**该报给外部的**窗口与输出上限。
 *
 * 规则：有 `__max` 变体就报 Max 那一套（1M / 64000），否则报 dev 的（200K / 32000）。
 * `modelsOf` 和 `catalogOf` 都从这里取，各算一遍会出现「模型列表报 1M、上下文编辑器
 * 报 200K」这种自相矛盾。
 */
export function effectiveLimits(model: TraeModelConfig): {
  hasMax: boolean;
  contextWindow: number;
  maxTokens: number;
} {
  const hasMax = model.maxModelName !== null;
  const contextWindow = hasMax ? (model.maxContext ?? model.contextWindow) : model.contextWindow;
  const maxTokens = (hasMax ? (model.maxTokensMax ?? model.maxTokens) : model.maxTokens) || model.maxTokens;
  return { hasMax, contextWindow, maxTokens };
}

/**
 * 从 `model_detail_list` 里挑指定变体的 `model_name`（`__dev` / `__max`）。
 *
 * 挑不到返回 `null`——调用方据此判断「这个模型没有那个变体」，不要瞎拼后缀：
 * 拼错的名字服务端回 `4023 model is unknown`。
 */
function variantName(info: any, suffix: '__dev' | '__max'): string | null {
  const list = Array.isArray(info?.model_detail_list) ? info.model_detail_list : [];
  const hit = list.find((item: any) => typeof item?.model_name === 'string' && item.model_name.endsWith(suffix));
  return hit ? hit.model_name : null;
}

/**
 * 从 `model_detail_list` 里挑 `__dev` 那一份。
 *
 * **不能写死 `[0]`**：现在两条恰好是 `__dev` 在前、`__max` 在后，但那是服务端的排列
 * 习惯，不是契约。挑错了会把 Max 的 64000/936000 当成默认值报出去。
 *
 * 没有 `__dev` 后缀（老配置或换了命名）就退回第一条。
 */
function pickDevDetail(info: any): any {
  const list = Array.isArray(info?.model_detail_list) ? info.model_detail_list : [];
  const dev = list.find((item: any) => typeof item?.model_name === 'string' && item.model_name.endsWith('__dev'));
  return dev || list[0] || {};
}

/**
 * 从 `model_detail_list` 里挑 `__max` 那一份（拿它的 `max_tokens`）。
 *
 * 没有就返回 `null`：调用方此时不要报 Max 的输出上限。
 */
function pickMaxDetail(info: any): any {
  const list = Array.isArray(info?.model_detail_list) ? info.model_detail_list : [];
  const hit = list.find((item: any) => typeof item?.model_name === 'string' && item.model_name.endsWith('__max'));
  return hit || null;
}

/**
 * 把 `batch_get_detail_param` 的响应解析成模型列表。
 *
 * 过滤规则都是实测出来的：
 *   - `config_switch !== true`：关掉的
 *   - `is_invisible_to_user`：内部模型（`summary` / `title_generation` /
 *     `input_optimization` / `*-auto` 之类），界面上看不到
 *   - `display_config.is_custom_model`：`custom_model_*` 占位模板，不是真模型
 *   - `features.access` 不含 `0`：会员专享（例如 `Kimi-K3.1-Pro`），免费号选了会被拒
 *   - 没有 `display_name` 或 `consumption_rate.rate`：配置占位项，不可用
 *
 * 导出只为回归测试（`test/trae-config.mjs`）。
 */
export function parseTraeConfig(doc: any): TraeModelConfig[] {
  const groups = Array.isArray(doc?.function_configs) ? doc.function_configs : [];
  const group = groups.find((item: any) => item && item.function === CONFIG_FUNCTION) || groups[0];
  const infos = Array.isArray(group?.config_info_list) ? group.config_info_list : [];

  const out: TraeModelConfig[] = [];
  const seen = new Set<string>();

  for (const info of infos) {
    if (!info || info.config_switch !== true) continue;
    if (info.is_invisible_to_user === true) continue;

    const display = info.display_config || {};
    if (display.is_custom_model === true) continue;

    let contact: any = {};
    try {
      contact = JSON.parse(info.display_contact_config || '{}');
    } catch {
      contact = {};
    }
    const access = contact?.access?.data?.identity_list;
    if (Array.isArray(access) && !access.includes(0)) continue;

    const name = typeof display.display_name === 'string' ? display.display_name.trim() : '';
    const id = typeof info.config_name === 'string' ? info.config_name : '';
    if (!id || !name || seen.has(id)) continue;

    const rate = Number(contact?.consumption_rate?.data?.rate);
    if (!Number.isFinite(rate)) continue;

    const detail = pickDevDetail(info);
    const maxTokens = Number(detail.max_tokens);
    if (!Number.isFinite(maxTokens) || maxTokens <= 0) continue;

    const ctx = info.context_window_tokens || {};
    const dev = Number(ctx.dev);
    const max = Number(ctx.max);
    const maxModelName = variantName(info, '__max');
    // 上游没给 `context_window_tokens.dev` 时落 `DEFAULT_CONTEXT`（那是猜的），
    // 要标出来——否则界面会把一个默认值当成「这个模型的上限」。
    const contextEstimated = !(Number.isFinite(dev) && dev > 0);
    seen.add(id);
    out.push({
      id,
      name,
      contextWindow: contextEstimated ? DEFAULT_CONTEXT : dev,
      contextEstimated,
      maxContext: Number.isFinite(max) && max > 0 ? max : null,
      maxTokens,
      devModelName: variantName(info, '__dev'),
      // `__max` 变体存在才算「这个模型有 Max」。有 Max 时输出上限要按 Max 的那一份报
      // （64000 vs 32000），否则 DSH 会按 dev 的输出预算规划。
      maxModelName,
      maxTokensMax: pickMaxDetail(info) ? Number(pickMaxDetail(info).max_tokens) || null : null,
      rate,
      reasoning: display.model_capability === 'reasoning_model',
      multimodal: display.multimodal === true,
    });
  }

  return out;
}

/**
 * 对话请求该用的 `model_name`：优先 `__max` 变体，没有 Max 才用 `__dev`。
 *
 * 返回 `null` 表示配置里查不到这个模型（配置接口挂了或模型下架），调用方应退回
 * 「不带 `config_name`/`model_name`」的老请求形状。
 */
export async function traeVariantModelName(credential: any, modelId: string): Promise<string | null> {
  const models = await fetchTraeModelConfig(credential);
  const model = models.find((item) => item.id === modelId);
  if (!model) return null;
  return model.maxModelName || model.devModelName || null;
}

let cache: { at: number; token: string; models: TraeModelConfig[] } = { at: 0, token: '', models: [] };

/**
 * 拉一次模型配置（带 10 分钟缓存）。失败直接抛——上层会跳过这个账号并记原因，
 * 别退回一份会过期的本地快照。
 */
export async function fetchTraeModelConfig(credential: any, force = false): Promise<TraeModelConfig[]> {
  const token = typeof credential?.token === 'string' ? credential.token.slice(-12) : '';
  if (!force && cache.models.length > 0 && cache.token === token && Date.now() - cache.at < CONFIG_TTL_MS) {
    return cache.models;
  }

  const response = await fetch(`${TRAE_CHAT_BASE}/api/ide/v1/batch_get_detail_param`, {
    method: 'POST',
    headers: {
      ...traeHeaders(credential),
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ functions: [CONFIG_FUNCTION] }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`trae config http ${response.status}: ${text.slice(0, 160)}`);

  const models = parseTraeConfig(JSON.parse(text));
  if (models.length === 0) throw new Error('trae config 里没有可用模型');
  cache = { at: Date.now(), models, token };
  log(`模型目录已缓存 ${models.length} 个`);
  return models;
}

// ---------------------------------------------------------------- 对外形状

/**
 * 上游原始目录，给 `/models` 页的上下文窗口编辑器用（`catalogOf`）。
 *
 * 档位按 **Max 变体**给，和 `traeModelList()` 同源（都走 `effectiveLimits`）。阶梯仍是
 * 「小于等于上限」——调小是为了让 DSH 更早压缩、单次请求更便宜，不是为了突破上游。
 */
export async function traeCatalog(account: Account): Promise<CatalogModel[]> {
  const models = await fetchTraeModelConfig(account.credential);
  return models.map((model) => {
    const { contextWindow, maxTokens } = effectiveLimits(model);
    return {
      id: model.id,
      name: model.name,
      contextWindow,
      maxTokens,
      lengths: { default: contextWindow, options: contextOptions(contextWindow) },
      // 图像能力来自上游的 `display_config.multimodal`，不是写死的。
      supportsImages: model.multimodal,
      supportsReasoning: model.reasoning,
    };
  });
}

/** 倍率拼进显示名：0.78 → `GLM-5.3 · 0.78x`。取不到倍率就保持原名。 */
function withRateSuffix(name: string, rate: number | null) {
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) return name;
  return `${name} · ${rate.toFixed(2)}x`;
}

/**
 * 按 OpenAI `/v1/models` 的形状给模型列表（`modelsOf`）。
 *
 * 取不到就抛错，不退回手写快照：手写目录是第二份会过期的模型表，它错的那一刻比
 * 「没有模型」更危险——用户会在 DSH 里选到一个上游已下架、或能力报错了的模型，
 * 而且不会报错，只会静默跑坏。
 *
 * 名字里带倍率，和 WorkBuddy 一样由网关拼，DSH 的模型选择器里就能直接看出价格。
 */
export async function traeModelList(account: Account): Promise<ModelInfo[]> {
  const models = await fetchTraeModelConfig(account.credential);
  return models.map((model) => {
    const { hasMax, contextWindow, maxTokens } = effectiveLimits(model);
    // 只有「最终用的那个数」来自默认值才算猜的：有 Max 且上游给了 max 时，用的是上游的。
    const contextEstimated = model.contextEstimated === true && !(hasMax && model.maxContext);
    return {
      id: model.id,
      object: 'model',
      name: withRateSuffix(model.name, model.rate),
      context_length: contextWindow,
      max_output_tokens: maxTokens,
      // 上游没报窗口大小时 `contextWindow` 落的是默认值（见 `DEFAULT_CONTEXT`），
      // 标出来别让界面当成「最大」。
      ...(contextEstimated ? { contextLengthEstimated: true } : {}),
      // 和 WorkBuddy 一样把能力报出去：profile 的 `reasoningEfforts` 由它生成。
      reasoning: model.reasoning,
      input: model.multimodal ? ['text', 'image'] : ['text'],
    };
  });
}
