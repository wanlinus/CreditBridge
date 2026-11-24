// Loomy 模型目录：标准 OpenAI 兼容 `GET /api/v1/models`，返回 `{ data: [...] }`。
//
// **能力字段埋在 `capabilities` 里，不在顶层**（实测的原始响应）：
//
//   "capabilities": {
//     "reasoning": true,
//     "vision": false,
//     "function_calling": true,
//     "streaming": true,
//     "system_message": true,
//     "input_modalities": ["text"],
//     "output_modalities": ["text"]
//   },
//   "reasoning_efforts": ["low", "medium", "high", "xhigh"],
//   "default_reasoning_effort": "low"
//
// 读顶层的 `raw.reasoning` / `raw.supports_reasoning` 会得到 undefined——上游从来没
// 给过那两个字段，于是所有模型都被报成「不支持推理」，DSH 的思考强度选择器整个不出现。
//
// 协议分两种：`openai`（含 `openai_chat`）和 `anthropic`（含 `anthropic_messages`）。
// 网关只做 OpenAI 兼容出口，所以只取 openai 那批；anthropic 的模型（Claude 系）跳过
// ——DSH 这边没有对应协议出口，硬塞进去只会让请求 404。
//
// 列表**按账号取**：不同套餐看到的模型可能不同，所以缓存键是账号 id。

import type { Account, CatalogModel, ModelInfo } from '../../types.ts';
import { contextOptions } from '../../shared/model-settings.ts';
import { usableCredential } from '../../core/accounts.ts';
import { LOOMY_API_BASE, loomyApiHeaders, refreshLoomyCredential } from './auth.ts';

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; models: RawModel[] }>();

interface RawModel {
  id: string;
  name: string;
  protocol?: string;
  contextLength: number;
  maxOutput: number;
  reasoning: boolean;
  /** 上游给的思考档位（`["low","medium","high","xhigh"]`）；不支持推理时为空数组。 */
  reasoningEfforts: string[];
  /** 上游默认档位（`low`），没有就是 null。 */
  defaultReasoningEffort: string | null;
  input: string[];
}

/** 归一化上游一项。字段名跟着客户端 `normalizeFetchedModelMetadata` 走。 */
function normalizeModel(raw: any): RawModel | null {
  const id = String(raw?.id || '').trim();
  if (!id) return null;
  const protocol = String(raw?.protocol || 'openai').trim().toLowerCase();
  // 只收 openai 协议（含 openai_chat）；anthropic 系跳过。
  if (protocol !== 'openai' && protocol !== 'openai_chat') return null;
  const limit = raw?.limit && typeof raw.limit === 'object' ? raw.limit : {};
  const modalities = raw?.modalities && typeof raw.modalities === 'object' ? raw.modalities : {};
  // 能力在 `capabilities` 里（见文件头）。顶层的 `reasoning` / `supports_reasoning`
  // 一并认，是给将来上游两处都报的情况留余地——目前只会在 capabilities 里有。
  const capabilities = raw?.capabilities && typeof raw.capabilities === 'object' ? raw.capabilities : {};
  const reasoning =
    capabilities.reasoning === true || raw?.reasoning === true || raw?.supports_reasoning === true;
  // 输入模态同理：`capabilities.input_modalities` 是权威来源，`modalities.input` 是旧形状。
  const declaredInput = Array.isArray(capabilities.input_modalities)
    ? capabilities.input_modalities
    : Array.isArray(modalities.input)
      ? modalities.input
      : [];
  const input = declaredInput.map((m: any) => String(m).toLowerCase());
  if (!input.includes('text')) input.unshift('text');
  const efforts = Array.isArray(raw?.reasoning_efforts)
    ? raw.reasoning_efforts.map((e: any) => String(e).trim()).filter(Boolean)
    : [];
  return {
    id,
    name: String(raw?.displayName || raw?.name || id).trim() || id,
    contextLength: Number(limit.context ?? raw?.context_length ?? raw?.contextWindow) || 0,
    maxOutput: Number(limit.output ?? raw?.max_output_tokens) || 0,
    reasoning,
    // **只在自述支持推理时才带档位**：上游对图像类模型也会给空数组，别让它变成
    // 「支持推理但没有档位」这种自相矛盾的状态。
    reasoningEfforts: reasoning ? efforts : [],
    defaultReasoningEffort:
      reasoning && typeof raw?.default_reasoning_effort === 'string' ? raw.default_reasoning_effort.trim() || null : null,
    input,
  };
}

/** 从上游拉一次模型列表（openai 协议那批）。 */
export async function fetchLoomyModels(account: Account): Promise<RawModel[]> {
  const credential = await usableCredential(account, refreshLoomyCredential);
  const response = await fetch(`${LOOMY_API_BASE}/models`, {
    headers: loomyApiHeaders(credential.session),
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Loomy /models HTTP ${response.status}: ${text.slice(0, 200)}`);
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(`Loomy /models 返回非 JSON：${text.slice(0, 200)}`);
  }
  const list = Array.isArray(doc?.data) ? doc.data : (Array.isArray(doc) ? doc : []);
  const models = list.map(normalizeModel).filter(Boolean) as RawModel[];
  if (models.length === 0) throw new Error('Loomy /models 没返回任何 openai 协议模型');
  return models;
}

/** 带缓存的模型列表。 */
export async function loomyModels(account: Account): Promise<RawModel[]> {
  const cached = cache.get(account.id);
  if (cached && cached.models.length > 0 && Date.now() - cached.at < CACHE_TTL_MS) return cached.models;
  const models = await fetchLoomyModels(account);
  cache.set(account.id, { at: Date.now(), models });
  return models;
}

/** 构建 `/v1/models` 的响应数据。 */
export async function buildModelList(account: Account, defaultContextWindow: number, defaultMaxTokens: number): Promise<ModelInfo[]> {
  const models = await loomyModels(account);
  return models.map((model) => ({
    id: model.id,
    object: 'model',
    name: model.name,
    context_length: model.contextLength > 0 ? model.contextLength : defaultContextWindow,
    max_output_tokens: model.maxOutput > 0 ? model.maxOutput : defaultMaxTokens,
    // 上游没下发窗口大小时，上面那个是默认值不是上限，标出来让界面别把它当「最大」。
    ...(model.contextLength > 0 ? {} : { contextLengthEstimated: true }),
    reasoning: model.reasoning,
    // 档位表原样报出去：Loomy 是逐个模型下发 `reasoning_efforts` 的，不能拿一套
    // 标准四档套所有模型（见 `types.ts` 的 `reasoningEfforts` 注释）。
    ...(model.reasoning && model.reasoningEfforts.length > 0 ? { reasoningEfforts: model.reasoningEfforts } : {}),
    ...(model.defaultReasoningEffort ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
    input: model.input,
  }));
}

/**
 * 上游原始目录，给 `/models` 页的上下文窗口下拉用（`catalogOf`）。
 *
 * 和另外三个通道同构。Loomy 的上游**没有档位表**（只有一个 `limit.context`），
 * 所以 `lengths.options` 按上限比例推三档（`contextOptions`）——和 Qoder 老快照
 * 走同一条兜底路径。
 */
export async function loomyCatalog(account: Account, defaultMaxTokens: number): Promise<CatalogModel[]> {
  const models = await loomyModels(account);
  return models.map((model) => {
    const max = model.contextLength > 0 ? model.contextLength : 0;
    return {
      id: model.id,
      name: model.name,
      contextWindow: max,
      maxTokens: model.maxOutput > 0 ? model.maxOutput : defaultMaxTokens,
      lengths: { default: max, options: contextOptions(max) },
      supportsImages: model.input.includes('image'),
      supportsReasoning: model.reasoning,
    };
  });
}
