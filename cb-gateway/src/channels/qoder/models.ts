// Qoder 的模型目录：调上游模型列表接口现取，结果缓存到 `data/state/qoder-models.json`。
//
// **不写死名单**：模型是上游资产，会随产品迭代增删，写死就等于每次换模型都要改代码。
//
// 为什么要缓存：`/v1/models` 是面板打开模型选择器时就会问的接口，现取要等一次上游
// 往返，会让选模型卡住。
//
// 刷新策略（三条，都不挡用户）：
//   1. 有缓存 → 立刻返回，不阻塞
//   2. 缓存过期（默认 6 小时）→ 返回旧值的同时在后台刷新
//   3. 完全没有缓存 → 只能同步取一次（这是唯一会等的情况，只发生一次）
//
// 另外每轮对话成功后如果缓存比较旧，也在后台刷一次——那时 CLI 本来就是热的，
// 代价最低。
//
// **模型名必须原样**：CLI 对不存在的模型名**不报错**，静默退回 auto
// （实测，stderr 只抱怨一行）。所以校验必须基于实时拿到的名单，
// 否则用户以为在用 DeepSeek，实际在跑 auto，还照样扣积分。

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

/**
 * 取模型名单的注入点。
 *
 * **为什么是注入而不是直接调**：取模型要 COSY 签名，而签名需要账号凭据；
 * 账号归上游层（`upstream.ts`）管，模型层（本文件）只负责清单与窗口。
 * 再加一条 `models → upstream` 的 import 就和现有的 `upstream → models` 成环了。
 *
 * 由 `upstream.ts` 在首次取模型时注入。没注入就抛错，**不静默退回空列表**
 * ——空列表会让面板的模型选择器变成空的，看起来像"上游没有模型"。
 */
type ModelNameSource = () => Promise<string[]>;

let modelSource: ModelNameSource | null = null;

export function setModelNameSource(fn: ModelNameSource): void {
  modelSource = fn;
}

/**
 * 取模型名单。
 *
 * 旧实现在这里 spawn `qoderclicn --list-models`（2.4 秒一次进程启动）。
 * 2026-11-22 起改走上游 `GET /algo/api/v2/model/list`（COSY 签名），
 * 一次 HTTP，还能顺带拿到倍率与上下文窗口配置。
 */
export async function fetchModelsFromCli(): Promise<string[]> {
  if (modelSource === null) {
    throw new Error('模型名单的数据源还没注入（应由 upstream.ts 提供）');
  }
  const models = await modelSource();
  if (models.length === 0) {
    throw new Error('模型名单是空的：上游返回里没有可用模型');
  }
  return models;
}

/**
 * 当前已知的模型名。
 *
 * 有缓存就立刻回，过期在后台刷；完全没缓存才同步等（只发生一次）。
 */
export async function getModelNames(): Promise<string[]> {
  const cache = readCache();
  if (cache) {
    if (!isFresh(cache)) refreshInBackground('cache stale');
    return cache.models;
  }
  const models = await fetchModelsFromCli();
  writeCache(models);
  log(`模型名单已缓存 ${models.length} 个`);
  return models;
}

/** 后台刷新，失败只记日志——旧缓存继续用，比让面板报错强。 */
let refreshing = false;
function refreshInBackground(reason: string) {
  if (refreshing) return;
  refreshing = true;
  fetchModelsFromCli()
    .then((models) => {
      writeCache(models);
      log(`后台刷新模型名单 ${models.length} 个（${reason}）`);
    })
    .catch((error) => log(`后台刷新失败（${reason}）：${error.message}`))
    .finally(() => {
      refreshing = false;
    });
}

/**
 * 对话成功后调一次：缓存比较旧就顺手刷一下。
 *
 * 这时 CLI 刚跑过，系统里已有热数据，代价最低。只在超过 TTL 一半时才触发，
 * 避免每轮对话都多起一个进程。
 */
export function maybeRefreshAfterChat() {
  const cache = readCache();
  if (!cache) {
    refreshInBackground('chat 后无缓存');
    return;
  }
  if (Date.now() - cache.fetchedAt > CACHE_TTL_MS / 2) refreshInBackground('chat 后缓存偏旧');
}

/**
 * 构建 `/v1/models` 的响应数据。
 *
 * 倍率来自 `price-factors.json`（`/algo/api/v2/model/list` 的 `price_factor` 快照），
 * 拼进显示名成 `Qwen3.8-Max · 0.50x`——和 WorkBuddy / Trae 同一约定，DSH 的模型
 * 选择器就能显示倍率。快照里没有的模型（上游新增、还没重抓）退回纯名字，不加倍率，
 * 比「写死一个假值」诚实。
 *
 * `context_length` 优先用快照的 `maxInputTokens`（真实值），没有才退回网关默认值。
 *
 * 能力从快照的 `canThink` / `efforts` / `isVision` 来（源头是上游的 `thinking_config`
 * 和 `is_vl`）。**别用 `is_reasoning`**：它对 DeepSeek-Flash / Kimi-K3.1-Pro 报 false，
 * 但那两个模型的 `thinking_config.enabled.efforts` 有 high/low/max，实际支持思考。
 * 2026-11-11 用户就是看到 DeepSeek-Flash 显示「—」才发现这个坑。
 */
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
      // 快照里没有这个模型的窗口大小时，上面的数是**默认值不是上限**。
      // 标出来让界面说「默认 20 万（上游未报）」，而不是「最大 20 万」。
      ...(maxContext === null ? { contextLengthEstimated: true } : {}),
      // 能力字段：快照里有就用，没有就整个不报（前端显示「—」，不编）。
      ...(known
        ? {
            reasoning: known.canThink,
            // `none` 排最前：DSH 把它映射成 `off`（关闭思考）。能不能关取决于上游
            // 的 `thinking_config` 里有没有 `disabled` 段——有的模型思考只能开不能关。
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

/**
 * 这个模型**最大**的上下文窗口：上游 `context_config` 里最大的那一档。
 *
 * 2026-11 实测（容器内 MITM 抓 `model/list`）：所有 13 个模型都给
 * `context_config: {200K, 400K, 1M}`，默认 200K —— 所以 **1M 是真实上限**，
 * 不能读 `max_input_tokens`：它是个单次输入上限，`DeepSeek-V4-Pro` 报 96000、
 * `Qwen3.8-Max` 报 180000，都远小于模型真实能吃下的量。
 *
 * 没有 `contexts` 的老快照才退回 `maxInputTokens`。
 */
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
 *
 * 为什么聊天路径必须读这个、不能只读快照：
 *
 *   1. `/v1/models` 报给 DSH 的是**用户配的值**（`applyModelSettings` 会覆盖
 *      `context_length`）。聊天路径要是只认快照，两边就又分家了——用户把窗口调大
 *      （合法区间上限 2M），DSH 按 2M 规划压缩，而字符闸还按快照的 1M 算，
 *      2026-11-21 那个「会话一长就被拒」会原样复现，只是数字变了。
 *   2. `--context-window` 也得是同一个值，否则「界面选了 200K、CLI 还跑 1M」，
 *      下拉框就成了摆设。
 *
 * `prefix` 由通道自己传进来（`idPrefix`），不在这里写死 `'qd'`——元数据只有一份。
 */
export function effectiveContextWindowOf(prefix: string, modelName: string): number | null {
  const configured = settingOf(prefix, modelName)?.contextWindow;
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) return configured;
  return contextWindowOf(modelName);
}

/**
 * 上游原始目录，给 `/models` 页的上下文下拉用。
 *
 * `lengths.options` 是上游 `context_config` 的真实档位（200K / 400K / 1M）；选中的
 * 档位由 `effectiveContextWindowOf()` 读到，聊天路径的字符闸和它同源，所以**能生效**。
 */
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
  /**
   * 支不支持思考。
   *
   * **不看上游的 `is_reasoning`**：那个字段对 `DeepSeek-Flash` / `Kimi-K3.1-Pro`
   * 报的是 `false`，但它们的 `thinking_config.enabled.efforts` 里有 high/low/max——
   * 实际是支持思考的（2026-11-11 实测）。`is_reasoning` 更像「默认是否思考」的提示。
   * 真正的能力信号是 `thinking_config`：有 enabled.efforts 且非空才算支持。
   */
  canThink: boolean;
  /** 能不能把思考关掉（`thinking_config` 里有 `disabled` 段）。 */
  canDisableThinking: boolean;
  /** 上游给的思考档位名，按上游顺序（如 `['high','max','low']`）。 */
  efforts: string[];
  /** 上游默认档位；`Auto`/`Fast` 这类路由别名没有。 */
  defaultEffort: string | null;
  /** 图像输入能力（上游 `is_vl`）。 */
  isVision: boolean;
  /**
   * 上游的**上下文档位**（`context_config`）：一个模型可以在 200K / 400K / 1M 里选。
   *
   * `maxInputTokens` 是**默认那一档**，不是上限——2026-11 之前只读了它，于是
   * 界面上 Qoder 的模型全都显示 20 万，而 `Auto` 实际能到 100 万。快照里没有这个
   * 字段（老快照抓的时候没保留）时按 `maxInputTokens` 推一组比例档位。
   */
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
 * 把客户端传来的模型名对齐到上游真实名字。
 *
 * 大小写不敏感：DSH 和很多客户端会把模型名小写化（`deepseek-v4-pro`），
 * 而 CLI 只认 `DeepSeek-V4-Pro`。对不齐会让 `set_model` 静默失效。
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
