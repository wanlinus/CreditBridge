// Qoder 的模型目录：现取上游模型列表，缓存到 `data/state/qoder-models.json`（有缓存立刻回、
// 过期后台刷、无缓存才同步等）。**模型名必须原样**：CLI 对不存在的模型名不报错、静默退回 auto，
// 于是用户以为在用 DeepSeek、实际在跑 auto 还照样扣积分。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CatalogModel, ModelInfo } from '../../types.ts';
import { STATE_DIR } from '../../shared/paths.ts';
import { contextOptions, settingOf } from '../../shared/model-settings.ts';

// 倍率快照的落点：和 models.ts 同目录，随代码走（倍率是「官方口径」，不是运行时状态）。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRICE_FACTORS_PATH = path.join(__dirname, 'price-factors.json');

const CACHE_PATH = path.join(STATE_DIR, 'qoder-models.json');
/** 缓存有效期。6 小时足够跟上模型增删，又不会频繁起进程。 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

let logSink: any = null;
export function setModelsLogger(fn: any) {
  logSink = fn;
}
function log(...args: unknown[]) {
  if (logSink) logSink(`[qoder-models] ${args.join(' ')}`);
}

interface ModelCache {
  fetchedAt: number;
  models: string[];
}

/** 读缓存；文件坏了当没有，不要因为一个坏 JSON 把通道弄成不可用。 */
function readCache(): ModelCache | null {
  try {
    const doc = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (!doc || !Array.isArray(doc.models) || doc.models.length === 0) return null;
    const models = doc.models.filter((m: any) => typeof m === 'string' && m.trim() !== '');
    if (models.length === 0) return null;
    return { fetchedAt: Number(doc.fetchedAt) || 0, models };
  } catch {
    return null;
  }
}

function writeCache(models: string[]) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify({ fetchedAt: Date.now(), models }, null, 2));
  } catch (error: any) {
    log(`模型缓存写入失败：${error.message}`);
  }
}

function isFresh(cache: ModelCache | null): boolean {
  if (!cache) return false;
  return Date.now() - cache.fetchedAt < CACHE_TTL_MS;
}

/** 取模型名单的注入点。**必须注入而不是直接调**：取模型要 COSY 签名、需要账号凭据，而账号归 `upstream.ts` 管；反过来 import 会和 `upstream → models` 成环。
 * 没注入就抛错，**不静默退回空列表**——那会让模型选择器看起来像「上游没有模型」。 */
type ModelNameSource = () => Promise<string[]>;

let modelSource: ModelNameSource | null = null;

export function setModelNameSource(fn: ModelNameSource): void {
  modelSource = fn;
}

/** 取模型名单（数据源由 `upstream.ts` 注入，走 HTTP，不是 CLI）。 */
export async function fetchQoderModels(): Promise<string[]> {
  if (modelSource === null) {
    throw new Error('模型名单的数据源还没注入（应由 upstream.ts 提供）');
  }
  const models = await modelSource();
  if (models.length === 0) {
    throw new Error('模型名单是空的：上游返回里没有可用模型');
  }
  return models;
}

/** 当前已知的模型名：有缓存就立刻回，过期在后台刷，完全没缓存才同步等（只发生一次）。 */
export async function getModelNames(): Promise<string[]> {
  const cache = readCache();
  if (cache) {
    if (!isFresh(cache)) refreshInBackground('cache stale');
    return cache.models;
  }
  const models = await fetchQoderModels();
  writeCache(models);
  log(`模型名单已缓存 ${models.length} 个`);
  return models;
}

/** 后台刷新，失败只记日志——旧缓存继续用，比让面板报错强。 */
let refreshing = false;
function refreshInBackground(reason: string) {
  if (refreshing) return;
  refreshing = true;
  fetchQoderModels()
    .then((models) => {
      writeCache(models);
      log(`后台刷新模型名单 ${models.length} 个（${reason}）`);
    })
    .catch((error) => log(`后台刷新失败（${reason}）：${error.message}`))
    .finally(() => {
      refreshing = false;
    });
}

/** 对话成功后调一次：缓存超过 TTL 一半才顺手刷，避免每轮都多一次请求。 */
export function maybeRefreshAfterChat() {
  const cache = readCache();
  if (!cache) {
    refreshInBackground('chat 后无缓存');
    return;
  }
  if (Date.now() - cache.fetchedAt > CACHE_TTL_MS / 2) refreshInBackground('chat 后缓存偏旧');
}

/** 构建 `/v1/models` 的响应数据：倍率来自 `price-factors.json` 快照，拼进显示名成 `Qwen3.8-Max · 0.50x`（和 WorkBuddy / Trae 同一约定），快照里没有的退回纯名字、不编。
 * 能力从快照的 `canThink` / `efforts` / `isVision` 来。**别用上游的 `is_reasoning`**：它对 DeepSeek-Flash / Kimi-K3.1-Pro 报 false，但实际支持思考，`thinking_config.enabled.efforts` 有值。 */
export function buildModelList(models: string[], defaultContextWindow: number, defaultMaxTokens: number): ModelInfo[] {
  const rates = readPriceFactors();
  return models.map((name) => {
    const known = rates.find((item) => item.displayName.toLowerCase() === name.toLowerCase());
    const displayName = known ? `${name} · ${known.priceFactor.toFixed(2)}x` : name;
    const maxContext = maxContextOfEntry(known);
    return {
      id: name,
      object: 'model',
      name: displayName,
      context_length: maxContext ?? defaultContextWindow,
      max_output_tokens: defaultMaxTokens,
      // 快照里没有窗口大小时，上面的数是**默认值不是上限**，标出来让界面说「默认」而不是「最大」。
      ...(maxContext === null ? { contextLengthEstimated: true } : {}),
      ...(known
        ? {
            reasoning: known.canThink,
            ...(known.canThink && known.efforts.length > 0
              ? {
                  reasoningEfforts: [...(known.canDisableThinking ? ['none'] : []), ...known.efforts],
                  ...(known.defaultEffort ? { defaultReasoningEffort: known.defaultEffort } : {}),
                }
              : {}),
            input: known.isVision ? ['text', 'image'] : ['text'],
          }
        : {}),
    };
  });
}

/** 这个模型**最大**的上下文窗口：上游 `context_config` 里最大的那一档（实测所有 13 个模型都给 200K/400K/1M，默认 200K）。**不能读 `max_input_tokens`**：那是单次输入上限， `DeepSeek-V4-Pro` 报 96000、`Qwen3.8-Max` 报 180000，远小于真实能吃的量。
 * 没有 `contexts` 的老快照才退回 `maxInputTokens`。 */
function maxContextOfEntry(known: PriceFactor | undefined): number | null {
  if (!known) return null;
  const tokens = (known.contexts ?? []).map((item) => item.tokens).filter((n) => n > 0);
  if (tokens.length > 0) return Math.max(...tokens);
  return known.maxInputTokens > 0 ? known.maxInputTokens : null;
}

/** 这个模型可选的上文档位（升序）。没抓到 `context_config` 时按上限推三档。 */
function contextTiersOfEntry(known: PriceFactor | undefined): number[] {
  const max = maxContextOfEntry(known) ?? 0;
  const declared = (known?.contexts ?? [])
    .map((item) => item.tokens)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  return declared.length > 0 ? [...new Set(declared)] : contextOptions(max);
}

/** 某个模型名对应的**最大**上下文窗口；快照里没有返回 `null`。 */
export function contextWindowOf(modelName: string): number | null {
  const rates = readPriceFactors();
  const hit = rates.find((item) => item.displayName.toLowerCase() === String(modelName).toLowerCase());
  return maxContextOfEntry(hit);
}

/**
 * 这个模型**实际生效**的窗口：用户在 `/models` 页配过就用配的，否则用快照最大值。
 * 聊天路径必须读这个而不是只读快照——`/v1/models` 报给 DSH 的是**用户配的值**，
 * 两边不同源的话，用户把窗口调大后 DSH 按新值规划压缩、字符闸却还按快照算，
 * 「会话一长就被拒」会原样复现。
 * @param prefix 由通道传进来（`idPrefix`），不在这里写死。
 */
export function effectiveContextWindowOf(prefix: string, modelName: string): number | null {
  const configured = settingOf(prefix, modelName)?.contextWindow;
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) return configured;
  return contextWindowOf(modelName);
}

/** 上游原始目录，给 `/models` 页的上下文下拉用。`lengths.options` 是 `context_config` 的真实档位。 */
export function qoderCatalog(defaultMaxTokens: number): CatalogModel[] {
  const rates = readPriceFactors();
  return rates.map((entry) => {
    const max = maxContextOfEntry(entry) ?? 0;
    return {
      id: entry.displayName,
      name: entry.displayName,
      contextWindow: max,
      maxTokens: defaultMaxTokens,
      lengths: { default: max, options: contextTiersOfEntry(entry) },
      supportsImages: entry.isVision,
      supportsReasoning: entry.canThink,
    };
  });
}

/** 倍率快照里的一项（去掉抓包脚本里的冗余字段，只留这里要用的）。 */
interface PriceFactor {
  displayName: string;
  priceFactor: number;
  maxInputTokens: number;
  /** 支不支持思考。**不看上游的 `is_reasoning`**：它对 `DeepSeek-Flash` / `Kimi-K3.1-Pro` 报 `false`，但 `thinking_config.enabled.efforts` 有值、实际支持思考。
   * 真正的信号是 `thinking_config`：有 enabled.efforts 且非空才算支持。 */
  canThink: boolean;
  /** 能不能把思考关掉（`thinking_config` 里有 `disabled` 段）。 */
  canDisableThinking: boolean;
  /** 上游给的思考档位名，按上游顺序（如 `['high','max','low']`）。 */
  efforts: string[];
  /** 上游默认档位；`Auto`/`Fast` 这类路由别名没有。 */
  defaultEffort: string | null;
  /** 图像输入能力（上游 `is_vl`）。 */
  isVision: boolean;
  /** 上游的**上下文档位**（`context_config`）：一个模型可以在 200K / 400K / 1M 里选。
   * `maxInputTokens` 是**默认那一档**、不是上限——只读它会让界面把 Qoder 的模型全显示成 20 万。老快照没有这个字段时按 `maxInputTokens` 推一组比例档位。 */
  contexts?: { label: string; tokens: number; isDefault: boolean }[];
}

/** 读倍率快照；文件坏了返回空表，不影响模型列表本身。 */
function readPriceFactors(): PriceFactor[] {
  try {
    const doc = JSON.parse(fs.readFileSync(PRICE_FACTORS_PATH, 'utf8'));
    if (!doc || !Array.isArray(doc.models)) return [];
    return doc.models
      .filter(
        (item: any) =>
          item &&
          typeof item.displayName === 'string' &&
          item.displayName !== '' &&
          typeof item.priceFactor === 'number' &&
          Number.isFinite(item.priceFactor),
      )
      .map((item: any) => ({
        displayName: item.displayName,
        priceFactor: item.priceFactor,
        maxInputTokens: typeof item.maxInputTokens === 'number' ? item.maxInputTokens : 0,
        canThink: item.canThink === true,
        canDisableThinking: item.canDisableThinking === true,
        efforts: Array.isArray(item.efforts) ? item.efforts.filter((e: any) => typeof e === 'string' && e !== '') : [],
        defaultEffort: typeof item.defaultEffort === 'string' && item.defaultEffort !== '' ? item.defaultEffort : null,
        isVision: item.isVision === true,
        contexts: Array.isArray(item.contexts)
          ? item.contexts
              .filter((c: any) => c && typeof c.tokens === 'number' && Number.isFinite(c.tokens) && c.tokens > 0)
              .map((c: any) => ({
                label: typeof c.label === 'string' ? c.label : String(c.tokens),
                tokens: c.tokens,
                isDefault: c.isDefault === true,
              }))
          : undefined,
      }));
  } catch {
    return [];
  }
}

/**
 * 把客户端传来的模型名对齐到上游真实名字。大小写不敏感：DSH 和很多客户端会把模型名
 * 小写化（`deepseek-v4-pro`），而上游只认 `DeepSeek-V4-Pro`，对不齐会让请求静默失效。
 */
export function resolveModelName(requested: string, known: string[]): string | undefined {
  if (typeof requested !== 'string' || requested === '') return undefined;
  const lower = requested.toLowerCase();
  return known.find((name) => name.toLowerCase() === lower);
}

/** 清掉缓存（登录换账号后名单可能变）。 */
export function invalidateModelCache() {
  try {
    fs.rmSync(CACHE_PATH, { force: true });
  } catch {
    /* 没有就算了 */
  }
}
