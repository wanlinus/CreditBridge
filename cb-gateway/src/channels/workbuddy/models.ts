// WorkBuddy 的模型目录：`GET /v3/config`。`data.models` 是**全量目录**（实测 66 个，含实验分支/补全/
// 图片视频模型），而客户端选择器只列「三个路由预设 + `data.agents[].models`」。
// 只读 `data.models` 会在 DSH 里塞进 57 个客户端根本不提供的模型——列表长到没法选。

import type { Account, CatalogModel, ModelInfo } from '../../types.ts';
import { usableCredential } from '../../core/accounts.ts';
import { refreshWorkBuddyCredential, WORKBUDDY_TIMEOUT_MS, workBuddyUserAgent } from './auth.ts';

const CONFIG_URL = 'https://copilot.tencent.com/v3/config';
const CATALOG_TTL_MS = 10 * 60 * 1000;

let logSink: any = null;
export function setWorkBuddyModelsLogger(fn: any) {
  logSink = fn;
}
function log(...args: unknown[]) {
  if (logSink) logSink(`[workbuddy-models] ${args.join(' ')}`);
}

/**
 * 模型目录缓存，**按账号分开**：套餐不同的号目录不一样，A 取过的目录被 B 拿去用，
 * B 会看到一批自己调不了的模型。键是账号 id。
 */
const catalogCache = new Map<string, { at: number; models: CatalogModel[] }>();

function catalogHeaders(credential: any) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.accessToken}`,
    Accept: 'application/json',
    Origin: 'https://www.codebuddy.cn',
    Referer: 'https://www.codebuddy.cn/',
    'User-Agent': workBuddyUserAgent(),
  };
  if (credential.uid) headers['X-User-Id'] = credential.uid;
  if (credential.enterpriseId) {
    headers['X-Enterprise-Id'] = credential.enterpriseId;
    headers['X-Tenant-Id'] = credential.enterpriseId;
  }
  if (credential.domain) headers['X-Domain'] = credential.domain;
  return headers;
}

/**
 * 客户端选择器实际列出的模型 id。一个 agent 模型都没拿到时返回 `null`（老版本配置没这个字段），
 * 调用方退回全量。导出只为回归测试核对「预设在前、agent 在后」。
 */
export function selectorOrder(data: any): string[] | null {
  const presets = ['fast-model', 'balanced-model', 'deep-model'];
  const agentIds: string[] = [];
  const agents = Array.isArray(data?.agents) ? data.agents : [];
  for (const agent of agents) {
    if (!Array.isArray(agent?.models)) continue;
    for (const id of agent.models) {
      if (typeof id === 'string' && id !== '' && !agentIds.includes(id)) agentIds.push(id);
    }
  }
  if (agentIds.length === 0) return null;
  return [...presets, ...agentIds];
}

/** 上游目录项 → `CatalogModel`。字段名映射的理由见下面 `fetchWorkBuddyModels`。 */
function toCatalogModel(model: any): CatalogModel & { credits?: string } {
  return {
    id: model.id,
    name: typeof model.name === 'string' ? model.name : model.id,
    // 目录里这两个字段叫 maxInputTokens / maxOutputTokens。读错名字会静默回退到默认值，
    // `/v1/models` 全线报 200000 而不报任何错。
    contextWindow: Number.isFinite(model.maxInputTokens)
      ? model.maxInputTokens
      : (Number.isFinite(model.contextWindow) ? model.contextWindow : undefined),
    maxTokens: Number.isFinite(model.maxOutputTokens)
      ? model.maxOutputTokens
      : (Number.isFinite(model.maxTokens) ? model.maxTokens : undefined),
    lengths:
      model.contextWindow && Array.isArray(model.contextWindow.supportedLengths)
        ? {
            default: model.contextWindow.defaultLength,
            options: model.contextWindow.supportedLengths.filter((n: any) => Number.isFinite(n)),
          }
        : undefined,
    supportsImages: model.supportsImages === true,
    supportsReasoning: model.supportsReasoning === true,
    reasoning: model.reasoning && typeof model.reasoning === 'object' ? model.reasoning : undefined,
    // 上游的积分倍率，形如 "x0.15"。这里只负责原样带上来，显示名由 `buildModelList()` 拼——
    // 别在映射层做展示格式，那会让消费原始目录的地方也看到被改过的名字。
    credits: typeof model.credits === 'string' ? model.credits : undefined,
  };
}

/**
 * 上游原始目录 = 客户端选择器会列出的那些（见 `selectorOrder`）。`lengths.options` 是客户端那个
 * 选择器的数据（provider 真正接受的档位尺寸），不是上限的某个比例——没有这个字段的模型根本调不了窗口。
 */
export async function fetchWorkBuddyModels(account: Account, force = false): Promise<CatalogModel[]> {
  const cached = catalogCache.get(account.id);
  if (!force && cached && cached.models.length > 0 && Date.now() - cached.at < CATALOG_TTL_MS) return cached.models;
  // 取目录也要用新鲜凭据：放了一夜没动的号，token 早过期了。
  const credential = await usableCredential(account, refreshWorkBuddyCredential);
  const response = await fetch(CONFIG_URL, { headers: catalogHeaders(credential), signal: AbortSignal.timeout(WORKBUDDY_TIMEOUT_MS) });
  const text = await response.text();
  if (!response.ok) throw new Error(`catalog http ${response.status}: ${text.slice(0, 200)}`);
  const doc = JSON.parse(text);
  if (doc.code !== 0) throw new Error(`catalog code ${doc.code}: ${String(doc.msg || '').slice(0, 200)}`);

  const raw = doc.data && Array.isArray(doc.data.models) ? doc.data.models : [];
  const byId = new Map<string, any>();
  for (const model of raw) {
    if (model && typeof model.id === 'string') byId.set(model.id, model);
  }
  const order = selectorOrder(doc.data);
  const picked = order === null ? [...byId.keys()] : order.filter((id) => byId.has(id));
  if (order !== null) log(`catalog: 全量 ${byId.size} 个，选择器只列 ${picked.length} 个`);

  const models = picked
    .map((id) => byId.get(id))
    .filter((model: any) => !(Array.isArray(model.tags) && model.tags.some((tag: any) => /text-to-image|text-to-video|image-to-video/u.test(String(tag)))))
    .filter((model: any) => !/^(codewise-|completion-|deepseek-v3-0324-taco)/u.test(model.id))
    .map(toCatalogModel) as CatalogModel[];

  catalogCache.set(account.id, { at: Date.now(), models });
  return models;
}

/** 把上游的积分倍率拼进模型显示名。上游目录每条带一个 `credits` 字段（形如 `"x0.15"` = 0.15 倍），由网关实时拼——人工维护对照表会随模型增删和促销调整过期，而那种过期不报错、只让显示的价格是错的。
 * 少数模型（如 `auto`）故意没有 `credits`（倍率随任务浮动），这种保持原名、不编数字。 */
function withCreditMultiplier(name: string, credits: any) {
  const match = /^x\s*([0-9]+(?:\.[0-9]+)?)$/iu.exec(String(credits ?? '').trim());
  if (!match) return name;
  return `${name} · ${Number(match[1]).toFixed(2)}x`;
}

export function buildModelList(models: any[], defaultContextWindow: number, defaultMaxTokens: number): ModelInfo[] {
  return models.map((model) => ({
    id: model.id,
    object: 'model',
    // 倍率直接拼进显示名（见 `withCreditMultiplier`）。这里拼的是**上游原名**，账号段和通道段由 `core/router.ts` 加。
    name: withCreditMultiplier(model.name, model.credits),
    context_length: model.contextWindow || defaultContextWindow,
    max_output_tokens: model.maxTokens || defaultMaxTokens,
    // 上游没报窗口大小时标出来：那是「不知道」，不是「上游只有这么大」。
    ...(model.contextWindow ? {} : { contextLengthEstimated: true }),
    reasoning: model.supportsReasoning === true,
    input: model.supportsImages === true ? ['text', 'image'] : ['text'],
  }));
}
