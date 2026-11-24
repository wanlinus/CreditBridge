// 模型可见性：决定 `/v1/models` 回哪些模型。两级筛子都在 `channel_visibility` 表里，改完立刻生效、不用重启。
//   总闸（`listed`）通道级：`false` = 整个通道的模型都不进列表
//   清单（`models`）逐模型：只列出的那些可见，**顺序也按列表来**
// 语义：没有行 = 显示且不限；`models` 为空 = 全部显示。总闸关掉时不看清单，打开后原来的勾选还在。

import {
  deleteVisibility,
  listVisibility,
  putVisibility,
  type VisibilityRow,
} from '../store/settings.ts';

function cleanIds(value: any): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const id of value) {
    if (typeof id === 'string' && id !== '') seen.add(id);
  }
  return [...seen];
}

// 行数据有内存索引：`filterModels()` 一次要问两次，而 `/api/models` 是每通道每账号各问一遍，
// 实测 360 次从 7ms 降到 0.2ms。不做 TTL——可见性只能在 `/models` 页改，没有绕过网关改库的场景。
let visibilityCache: Map<string, VisibilityRow> | null = null;

function visibilityIndex(): Map<string, VisibilityRow> {
  if (visibilityCache === null) {
    visibilityCache = new Map(listVisibility().map((row) => [row.channelPrefix, row]));
  }
  return visibilityCache;
}

function invalidateVisibilityCache(): void {
  visibilityCache = null;
}

function rowOf(channelId: string): VisibilityRow | undefined {
  return visibilityIndex().get(channelId);
}

/** 全是默认值就删行——这是「看得出哪些通道被显式配过」的唯一保证，不删的话表里很快全是没意义的 `listed=1, models=null`。 */
function saveRow(channelId: string, row: { listed: boolean; models: string[] | null }): void {
  if (row.listed && row.models === null) deleteVisibility(channelId);
  else putVisibility({ channelPrefix: channelId, listed: row.listed, models: row.models });
  invalidateVisibilityCache();
}

/** 全部通道的可见清单。没有清单（不限）的通道不出现在结果里。 */
export function visibleModels(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const row of visibilityIndex().values()) {
    if (row.models !== null) out[row.channelPrefix] = cleanIds(row.models);
  }
  return out;
}

/** 某个通道的可见清单；`null` 表示不限。返回副本：直接交出去的话调用方 push 一下就把缓存改了，而 `setListed()` 恰好拿它去写库。 */
export function visibleFor(channelId: string): string[] | null {
  const row = rowOf(channelId);
  return row?.models ? [...row.models] : null;
}

/** 通道总闸：默认 `true`（没有行就是开）。 */
export function isListed(channelId: string): boolean {
  const row = rowOf(channelId);
  return row ? row.listed : true;
}

export function setListed(channelId: string, listed: boolean): void {
  saveRow(channelId, { listed, models: visibleFor(channelId) });
}

/** `null` 表示删掉限制、恢复全部显示。 */
export function setVisibleFor(channelId: string, ids: string[] | null): void {
  saveRow(channelId, { listed: isListed(channelId), models: ids === null ? null : cleanIds(ids) });
}

/** 按可见清单过滤并排序。配置里有、上游已经没有的 id 直接丢掉：上游目录会增删，残留 id 不该让整个列表变空。 */
export function filterModels<T extends { id: string }>(channelId: string, models: T[]): T[] {
  if (!isListed(channelId)) return [];
  const ids = visibleFor(channelId);
  if (ids === null) return models;
  const byId = new Map(models.map((model) => [model.id, model]));
  const out: T[] = [];
  for (const id of ids) {
    const model = byId.get(id);
    if (model) out.push(model);
  }
  return out;
}
