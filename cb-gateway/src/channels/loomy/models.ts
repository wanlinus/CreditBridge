import type { Account, ModelInfo } from '../../types.ts';
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
  reasoningEfforts: string[];
  defaultReasoningEffort: string | null;
  input: string[];
}

function normalizeModel(raw: any): RawModel | null {
  const id = String(raw?.id || '').trim();
  if (!id) return null;
  const protocol = String(raw?.protocol || 'openai').trim().toLowerCase();
  if (protocol !== 'openai' && protocol !== 'openai_chat') return null;
  const limit = raw?.limit && typeof raw.limit === 'object' ? raw.limit : {};
  const modalities = raw?.modalities && typeof raw.modalities === 'object' ? raw.modalities : {};
  const capabilities = raw?.capabilities && typeof raw.capabilities === 'object' ? raw.capabilities : {};
  const reasoning =
    capabilities.reasoning === true || raw?.reasoning === true || raw?.supports_reasoning === true;
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
    reasoning: model.reasoning,
    ...(model.reasoning && model.reasoningEfforts.length > 0 ? { reasoningEfforts: model.reasoningEfforts } : {}),
    ...(model.defaultReasoningEffort ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
    input: model.input,
  }));
}
