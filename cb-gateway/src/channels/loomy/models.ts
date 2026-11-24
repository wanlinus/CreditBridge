// Loomy 模型目录：标准 OpenAI 兼容 `GET /api/v1/models`。
// 坑：**能力字段埋在 `capabilities` 里、不在顶层**（`capabilities.reasoning` / `input_modalities`）；
// 读顶层 `raw.reasoning` 会得到 undefined，于是所有模型都被报成「不支持推理」、DSH 的思考强度选择器整个不出现。
// 只收 `openai` / `openai_chat` 协议的模型，anthropic 系（Claude）跳过；列表按账号取、缓存键是账号 id。

import type { Account, CatalogModel, ModelInfo } from '../../types.ts';
import { contextOptions } from '../../shared/model-settings.ts';
import { usableCredential } from '../../core/accounts.ts';
import { LOOMY_API_BASE, LOOMY_TIMEOUT_MS, loomyApiHeaders, refreshLoomyCredential } from './auth.ts';

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
  if (protocol !== 'openai' && protocol !== 'openai_chat') return null;
  const limit = raw?.limit && typeof raw.limit === 'object' ? raw.limit : {};
  const modalities = raw?.modalities && typeof raw.modalities === 'object' ? raw.modalities : {};
  // 能力在 `capabilities` 里（见文件头）；顶层两个也一并认，给将来上游两处都报留余地。
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

export async function fetchLoomyModels(account: Account): Promise<RawModel[]> {
  const credential = await usableCredential(account, refreshLoomyCredential);
  const response = await fetch(`${LOOMY_API_BASE}/models`, {
    headers: loomyApiHeaders(credential.session),
    signal: AbortSignal.timeout(LOOMY_TIMEOUT_MS),
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

export async function loomyModels(account: Account): Promise<RawModel[]> {
  const cached = cache.get(account.id);
  if (cached && cached.models.length > 0 && Date.now() - cached.at < CACHE_TTL_MS) return cached.models;
  const models = await fetchLoomyModels(account);
  cache.set(account.id, { at: Date.now(), models });
  return models;
}

export async function buildModelList(account: Account, defaultContextWindow: number, defaultMaxTokens: number): Promise<ModelInfo[]> {
  const models = await loomyModels(account);
  return models.map((model) => ({
    id: model.id,
    object: 'model',
    name: model.name,
    context_length: model.contextLength > 0 ? model.contextLength : defaultContextWindow,
    max_output_tokens: model.maxOutput > 0 ? model.maxOutput : defaultMaxTokens,
    ...(model.contextLength > 0 ? {} : { contextLengthEstimated: true }),
    reasoning: model.reasoning,
    // 档位表原样报出去：Loomy 是逐个模型下发 `reasoning_efforts` 的，不能拿一套标准四档套所有模型。
    ...(model.reasoning && model.reasoningEfforts.length > 0 ? { reasoningEfforts: model.reasoningEfforts } : {}),
    ...(model.defaultReasoningEffort ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
    input: model.input,
  }));
}

/**
 * 上游原始目录，给 `/models` 页的上下文窗口下拉用。Loomy 上游**没有档位表**（只有一个
 * `limit.context`），所以 `lengths.options` 按上限比例推三档（`contextOptions`）。
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
