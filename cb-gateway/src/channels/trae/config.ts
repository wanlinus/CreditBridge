import { TRAE_CHAT_BASE, traeHeaders } from './auth.ts';

const CONFIG_FUNCTION = 'solo_agent';
const CONFIG_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CONTEXT = 200000;

export type TraeModelConfig = {
  id: string;
  name: string;
  contextWindow: number;
  maxContext: number | null;
  maxTokens: number;
  maxTokensMax: number | null;
  devModelName: string | null;
  maxModelName: string | null;
  rate: number | null;
  reasoning: boolean;
  multimodal: boolean;
};

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

function variantName(info: any, suffix: '__dev' | '__max'): string | null {
  const list = Array.isArray(info?.model_detail_list) ? info.model_detail_list : [];
  const hit = list.find((item: any) => typeof item?.model_name === 'string' && item.model_name.endsWith(suffix));
  return hit ? hit.model_name : null;
}

function pickDevDetail(info: any): any {
  const list = Array.isArray(info?.model_detail_list) ? info.model_detail_list : [];
  const dev = list.find((item: any) => typeof item?.model_name === 'string' && item.model_name.endsWith('__dev'));
  return dev || list[0] || {};
}

function pickMaxDetail(info: any): any {
  const list = Array.isArray(info?.model_detail_list) ? info.model_detail_list : [];
  const hit = list.find((item: any) => typeof item?.model_name === 'string' && item.model_name.endsWith('__max'));
  return hit || null;
}

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
    seen.add(id);
    out.push({
      id,
      name,
      contextWindow: Number.isFinite(dev) && dev > 0 ? dev : DEFAULT_CONTEXT,
      maxContext: Number.isFinite(max) && max > 0 ? max : null,
      maxTokens,
      devModelName: variantName(info, '__dev'),
      maxModelName,
      maxTokensMax: pickMaxDetail(info) ? Number(pickMaxDetail(info).max_tokens) || null : null,
      rate,
      reasoning: display.model_capability === 'reasoning_model',
      multimodal: display.multimodal === true,
    });
  }

  return out;
}

export async function traeVariantModelName(credential: any, modelId: string): Promise<string | null> {
  const models = await fetchTraeModelConfig(credential);
  const model = models.find((item) => item.id === modelId);
  if (!model) return null;
  return model.maxModelName || model.devModelName || null;
}

let cache: { at: number; token: string; models: TraeModelConfig[] } = { at: 0, token: '', models: [] };

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
  return models;
}
