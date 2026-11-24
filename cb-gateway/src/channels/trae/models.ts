// Trae 的模型目录：`POST /api/ide/v1/batch_get_detail_param`（约 725KB，缓存 10 分钟）。三个反直觉的实测结论：
// ① **读 `solo_agent` 但对话发 `chat_v3`**：两份模型表不同，`solo_agent` 的数更宽且实测站得住（26 万 token 正常返回），
//    按 `chat_v3` 报会把能力白白砍半。② **报 `max` 变体**：实测 `__max` 吃下 49 万 token 正常返回。
// ③ 模型必须在对话请求**顶层**用 `config_name` + 带后缀的 `model_name` 声明；发裸名时服务端忽略模型、落到账号默认模型。

import type { Account, CatalogModel, ModelInfo } from '../../types.ts';
import { contextOptions } from '../../shared/model-settings.ts';
import { TRAE_CHAT_BASE, TRAE_TIMEOUT_MS, traeHeaders } from './auth.ts';

/** 取配置用的 function。**故意和对话请求的 `chat_v3` 不同**，原因见文件头。 */
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
  /** 两个变体的真实名字（`xxx__dev` / `__max`）。**Trae 认模型的唯一钥匙**：必须在顶层发 `config_name` + 带后缀的 `model_name`。 */
  devModelName: string | null;
  maxModelName: string | null;
  rate: number | null;
  reasoning: boolean;
  /** 支不支持图像输入（`display_config.multimodal`，与 `multimodal.enable` 交叉验证 17/17 一致）。 */
  multimodal: boolean;
};

/**
 * 这个模型**该报给外部的**窗口与输出上限：有 `__max` 就报 Max 那一套，否则报 dev 的。`modelsOf` 和 `catalogOf`
 * 都从这里取——各算一遍会出现「模型列表报 1M、上下文编辑器报 200K」。
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
 * 从 `model_detail_list` 里挑指定变体的 `model_name`。挑不到返回 `null`——不要瞎拼后缀，拼错回 `4023 model is unknown`。
 */
function variantName(info: any, suffix: '__dev' | '__max'): string | null {
  const list = Array.isArray(info?.model_detail_list) ? info.model_detail_list : [];
  const hit = list.find((item: any) => typeof item?.model_name === 'string' && item.model_name.endsWith(suffix));
  return hit ? hit.model_name : null;
}

/**
 * 从 `model_detail_list` 里挑 `__dev` 那一份。**不能写死 `[0]`**：现在两条恰好 `__dev` 在前，但那是服务端的排列
 * 习惯、不是契约，挑错会把 Max 的 64000/936000 当成默认值报出去。
 */
function pickDevDetail(info: any): any {
  const list = Array.isArray(info?.model_detail_list) ? info.model_detail_list : [];
  const dev = list.find((item: any) => typeof item?.model_name === 'string' && item.model_name.endsWith('__dev'));
  return dev || list[0] || {};
}

/** 从 `model_detail_list` 里挑 `__max` 那一份（拿它的 `max_tokens`），没有就返回 `null`。 */
function pickMaxDetail(info: any): any {
  const list = Array.isArray(info?.model_detail_list) ? info.model_detail_list : [];
  const hit = list.find((item: any) => typeof item?.model_name === 'string' && item.model_name.endsWith('__max'));
  return hit || null;
}

/** 解析模型列表。过滤规则都是实测出来的：关掉的、内部模型（`is_invisible_to_user`）、`is_custom_model` 占位模板、
 * 会员专享（`features.access` 不含 `0`，免费号选了会被拒）、缺 `display_name` 或 `consumption_rate.rate` 的占位项。 */
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
    // 上游没给 `context_window_tokens.dev` 时落 `DEFAULT_CONTEXT`（那是猜的），要标出来。
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
      // 有 Max 时输出上限要按 Max 那一份报（64000 vs 32000），否则 DSH 会按 dev 的输出预算规划。
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
 * 对话请求该用的 `model_name`：优先 `__max`，没有 Max 才用 `__dev`。返回 `null` 表示配置里查不到这个模型
 * （配置接口挂了或模型下架），调用方应退回不带 `config_name`/`model_name` 的老形状。
 */
export async function traeVariantModelName(credential: any, modelId: string): Promise<string | null> {
  const models = await fetchTraeModels(credential);
  const model = models.find((item) => item.id === modelId);
  if (!model) return null;
  return model.maxModelName || model.devModelName || null;
}

let cache: { at: number; token: string; models: TraeModelConfig[] } = { at: 0, token: '', models: [] };

/** 拉一次模型配置（带 10 分钟缓存）。失败直接抛——上层会跳过这个账号并记原因，别退回一份会过期的本地快照。 */
export async function fetchTraeModels(credential: any, force = false): Promise<TraeModelConfig[]> {
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
    signal: AbortSignal.timeout(TRAE_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`trae config http ${response.status}: ${text.slice(0, 160)}`);

  const models = parseTraeConfig(JSON.parse(text));
  if (models.length === 0) throw new Error('trae config 里没有可用模型');
  cache = { at: Date.now(), models, token };
  log(`模型目录已缓存 ${models.length} 个`);
  return models;
}

/**
 * 上游原始目录，给 `/models` 页的上下文窗口编辑器用。档位按 **Max 变体**给、和 `traeModelList()` 同源（都走 `effectiveLimits`）。
 */
export async function traeCatalog(account: Account): Promise<CatalogModel[]> {
  const models = await fetchTraeModels(account.credential);
  return models.map((model) => {
    const { contextWindow, maxTokens } = effectiveLimits(model);
    return {
      id: model.id,
      name: model.name,
      contextWindow,
      maxTokens,
      lengths: { default: contextWindow, options: contextOptions(contextWindow) },
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
 * 按 OpenAI `/v1/models` 的形状给模型列表。取不到就抛错，**不退回手写快照**：那是第二份会过期的
 * 模型表，它错的那一刻比「没有模型」更危险——用户会选到已下架或能力报错的模型，而且不报错、只静默跑坏。
 */
export async function traeModelList(account: Account): Promise<ModelInfo[]> {
  const models = await fetchTraeModels(account.credential);
  return models.map((model) => {
    const { hasMax, contextWindow, maxTokens } = effectiveLimits(model);
    const contextEstimated = model.contextEstimated === true && !(hasMax && model.maxContext);
    return {
      id: model.id,
      object: 'model',
      name: withRateSuffix(model.name, model.rate),
      context_length: contextWindow,
      max_output_tokens: maxTokens,
      ...(contextEstimated ? { contextLengthEstimated: true } : {}),
      reasoning: model.reasoning,
      input: model.multimodal ? ['text', 'image'] : ['text'],
    };
  });
}
