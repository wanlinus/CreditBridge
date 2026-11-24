/**
 * 模型目录、可见性与**模型设置**（上下文窗口 / 思考强度）。
 *
 * 三件不同的事，别混：
 *   - **目录**（`/api/models/catalog`）是这个通道/账号**实际能取到**的模型，不过可见性
 *   - **可见性**（`/api/models/visibility`）是「哪些愿意暴露给 `/v1/models`」
 *   - **设置**（`/api/models/settings`）是「这个模型的上下文窗口和缺省思考档」
 *
 * 键都是**通道短前缀**（`wb`），不是账号 id——改一次对该通道所有账号生效。
 *
 * 设置只有网关这一份（`data/config.json` 的 `modelSettings`）：DSH 插件不再提供
 * 上下文窗口下拉，它只是把 `/api/models` 报出来的值照抄进 profile。
 */
import { api } from './client';

interface ModelEntry {
  id: string;
  name?: string;
  /** 上下文窗口（上游口径，各通道字段名不同，通道自己归一化）。 */
  context_length?: number;
  max_output_tokens?: number;
  reasoning?: boolean;
  /** 可选思考档位；空数组 = 不能思考。`off` 已归一成 DSH 的叫法。 */
  efforts?: string[];
  /** 当前生效的缺省思考档（没配过 = 档位表里最高那一档）。 */
  effectiveEffort?: string | null;
  /** 当前生效的缺省上下文窗口（没配过 = 这个模型允许的最大尺寸）。 */
  effectiveContextWindow?: number;
  /** `context_length` 是网关的默认值而不是上游报的（上游没给这个模型的窗口大小）。 */
  contextLengthEstimated?: boolean;
  /** 用户在网关配过的值；`null` = 跟随上游。 */
  setting?: ModelSetting;
  /** 上游客户端自己那个选择器的可选尺寸；`null` = 上游没提供，自由填。 */
  lengths?: { default?: number; options?: number[] } | null;
  input?: string[] | null;
  [key: string]: unknown;
}

/** 一个模型的设置。`null` / 缺省都表示「跟随上游」。 */
export interface ModelSetting {
  contextWindow: number | null;
  maxOutputTokens: number | null;
  reasoningEffort: string | null;
}

/**
 * 注意：**这里没有 `creditRatio`**。倍率只由 `ledger.ts` 聚合进 `usage.byModel`，
 * 通道的 `modelsOf()` 从不返回它——写成可选字段会让界面以为「目录里每个模型都有倍率」，
 * 然后在表里渲染一片 `undefined`。
 */

export interface ChannelCatalog {
  channelId: string;
  idPrefix: string;
  label: string;
  /** 目录取自哪个账号（优先 ready）。`null` = 这个通道还没加号。 */
  source: string | null;
  models: ModelEntry[];
  error: string | null;
  /** `null` = 全部显示；数组 = 只显示这些。 */
  visible: string[] | null;
  listed: boolean;
  multiAccount: boolean;
}

export interface AccountCatalog {
  account: string;
  channelId: string;
  idPrefix: string;
  label: string;
  models: ModelEntry[];
  error: string | null;
  visible: string[] | null;
  listed: boolean;
}

export function getCatalog(): Promise<{ channels: ChannelCatalog[] }> {
  return api.get<{ channels: ChannelCatalog[] }>('/api/models/catalog');
}

export function getAccountCatalog(id: string): Promise<AccountCatalog> {
  return api.get<AccountCatalog>(`/api/models/catalog?account=${encodeURIComponent(id)}`);
}

export type VisibilityPatch =
  | { prefix: string; action: 'toggle-list'; listed: boolean }
  | { prefix: string; action: 'all' }
  | { prefix: string; visible: string[] };

export function saveVisibility(patch: VisibilityPatch): Promise<Record<string, unknown>> {
  return api.post<Record<string, unknown>>('/api/models/visibility', patch);
}

export interface SettingPatch {
  prefix: string;
  modelId: string;
  /** 传 `null` = 恢复默认（跟随上游）。 */
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  reasoningEffort?: string | null;
}

export function saveModelSetting(patch: SettingPatch): Promise<{ ok: boolean; setting: ModelSetting }> {
  return api.post<{ ok: boolean; setting: ModelSetting }>('/api/models/settings', patch);
}
