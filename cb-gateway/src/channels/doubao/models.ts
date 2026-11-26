// 豆包模型目录：`/alice/slot/action_bar_v3/brief_list` 里 `coco_deep_thinking` 那一项的
// `active_switch_conf.menu_conf.item_list` 就是模型表（14 个）。
//
// 三个坑：
// ① 档位字段叫 **`reasoning_effort_config`**，写成 `reasoning_effort` 会静默拿到空表，
//    然后走兜底四档——不报错，只是报给 DSH 的档位和上游无关。
// ② 档位是**数字 level**（3~7），不是 `low`/`high` 那种字符串，要查表归一。
// ③ 网页 HTML 里也有一份同样的表（未登录可取），但 `total_window_size` 会跳变
//    （同一个模型两次取到 300000 / 256000），**不能拿来定窗口**。

import type { Account, CatalogModel, ModelInfo } from '../../types.ts';
import { contextOptions } from '../../shared/model-settings.ts';
import { usableCredential } from '../../core/accounts.ts';
import { BOT_ID, postWeb, refreshDoubaoCredential } from './auth.ts';

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; items: RawModel[] }>();

/** 上游档位数字 → 网关的档位名。DSH 只认这几个，自造名字它不认识。 */
const EFFORT_NAMES: Record<number, string> = {
  3: 'low',
  4: 'medium',
  5: 'high',
  6: 'xhigh',
  7: 'max',
};

interface RawModel {
  key: string;
  name: string;
  contextWindow: number;
  maxOutput: number;
  reasoning: boolean;
  efforts: string[];
  defaultEffort: string | null;
  /** 请求里要原样抄回去的 `model_extra_params`。**不能只抄窗口大小**，`memory_profile` 也要。 */
  extraParams: Record<string, string>;
}

let logSink: any = null;
export function setModelsLogger(fn: any) {
  logSink = fn;
}
function log(...args: unknown[]) {
  if (logSink) logSink(`[doubao-models] ${args.join(' ')}`);
}

/** 把 `reasoning_effort_config` 归一成网关的档位数组。 */
function normalizeEfforts(config: any): { efforts: string[]; defaultEffort: string | null } {
  const list = Array.isArray(config?.option_list) ? config.option_list : [];
  const efforts: string[] = [];
  for (const option of list) {
    const level = Number(option?.level);
    const name = EFFORT_NAMES[level];
    // 表里没有的档不报——认不出来就宁可不用它，否则 DSH 会显示一个上游不认的选项。
    if (name && !efforts.includes(name)) efforts.push(name);
  }
  const defaultLevel = Number(config?.default_level);
  const defaultEffort = EFFORT_NAMES[defaultLevel] ?? null;
  return { efforts, defaultEffort: efforts.includes(defaultEffort ?? '') ? defaultEffort : null };
}

function normalizeModel(item: any): RawModel | null {
  const key = String(item?.model_item_key || '').trim();
  if (!key) return null;
  // `agent_mode: 2` 的是前端模式别名（`0` 快速 / `3` 专家），不是独立模型，没有窗口参数。
  if (Number(item?.agent_mode) === 2) return null;

  const params = item?.model_extra_params && typeof item.model_extra_params === 'object' ? item.model_extra_params : {};
  const contextWindow = Number(params.total_window_size) || 0;
  const { efforts, defaultEffort } = normalizeEfforts(item?.reasoning_effort_config);

  return {
    key,
    name: String(item?.name || key).trim() || key,
    contextWindow,
    // 豆包不报 max_output_tokens，用网关默认值填（`buildModelList` 里处理）。
    maxOutput: 0,
    reasoning: efforts.length > 0,
    efforts,
    defaultEffort,
    extraParams: Object.fromEntries(
      Object.entries(params)
        .filter(([, value]) => value !== null && value !== undefined)
        .map(([name, value]) => [name, String(value)]),
    ),
  };
}

/** 拉一次模型表。**按账号取**：不同号的套餐不同，表可能不一样。 */
export async function fetchModels(account: Account): Promise<RawModel[]> {
  const credential = await usableCredential(account, refreshDoubaoCredential);
  const doc = await postWeb(
    credential,
    '/alice/slot/action_bar_v3/brief_list',
    { language_code: 'zh', bot_id: BOT_ID, conversation_id: '' },
    { timeoutMs: 20_000 },
  );

  const entries = Array.isArray(doc?.data?.entry_list) ? doc.data.entry_list : [];
  const deepEntry = entries.find((entry: any) => entry?.action_bar_key === 'coco_deep_thinking');
  const items = Array.isArray(deepEntry?.active_switch_conf?.menu_conf?.item_list)
    ? deepEntry.active_switch_conf.menu_conf.item_list
    : [];

  const models = items.map(normalizeModel).filter(Boolean) as RawModel[];
  if (models.length === 0) throw new Error('豆包 brief_list 没返回任何模型（cookie 可能已失效）');
  log(`${account.id} 取到 ${models.length} 个模型`);
  return models;
}

export async function modelList(account: Account): Promise<RawModel[]> {
  const cached = cache.get(account.id);
  if (cached && cached.items.length > 0 && Date.now() - cached.at < CACHE_TTL_MS) return cached.items;
  const items = await fetchModels(account);
  cache.set(account.id, { at: Date.now(), items });
  return items;
}

/** 账号删掉/换号后清缓存，否则模型列表会一直挂着旧号的目录。 */
export function invalidateModelCache(accountId?: string): void {
  if (accountId) cache.delete(accountId);
  else cache.clear();
}

export function buildModelList(account: Account, defaultMaxTokens: number): Promise<ModelInfo[]> {
  return modelList(account).then((models) =>
    models.map((model) => ({
      id: model.key,
      object: 'model',
      name: model.name,
      // 上游没报窗口时用 0 会算出负数，所以退回网关默认值并标 `contextLengthEstimated`。
      context_length: model.contextWindow > 0 ? model.contextWindow : 0,
      max_output_tokens: defaultMaxTokens,
      ...(model.contextWindow > 0 ? {} : { contextLengthEstimated: true }),
      ...(model.reasoning
        ? {
            reasoning: true,
            reasoningEfforts: model.efforts,
            ...(model.defaultEffort ? { defaultReasoningEffort: model.defaultEffort } : {}),
          }
        : {}),
    })),
  );
}

/**
 * 上游原始目录，给 `/models` 页的上下文窗口下拉用。
 * 豆包**没有档位表**（每个模型只有一个 `total_window_size`），所以按上限比例推三档。
 */
export async function catalog(account: Account, defaultMaxTokens: number): Promise<CatalogModel[]> {
  const models = await modelList(account);
  return models.map((model) => {
    const max = model.contextWindow > 0 ? model.contextWindow : 0;
    return {
      id: model.key,
      name: model.name,
      contextWindow: max,
      maxTokens: defaultMaxTokens,
      lengths: max > 0 ? { default: max, options: contextOptions(max) } : undefined,
      supportsImages: false,
      supportsReasoning: model.reasoning,
    };
  });
}

/** 对话时要原样抄回请求体的 `model_extra_params`。缺了它上游按自己的默认档跑。 */
export async function extraParamsOf(account: Account, modelKey: string): Promise<Record<string, string>> {
  const models = await modelList(account);
  const hit = models.find((model) => model.key === modelKey);
  return hit ? hit.extraParams : {};
}
