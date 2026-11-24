// 模型设置（`model_setting`）+ 通道可见性（`channel_visibility`）——**唯一允许出现 SQL 的地方之一**。
//
// 这两项改完立刻生效、不用重启，所以进库；而 `host` / `port` / `checkinTime` 留在 `config.json`
// 里给运维手改。语义（「空值表示跟随上游」「总闸关掉时不看逐模型清单」）在 `shared/` 那两个文件。
//
// **全是默认值的行不写**：`channel_visibility` 的默认是「显示 + 不限」，只有被显式改过的通道才
// 在表里留一行，让人能看出「哪些是显式配的」。

import { db } from '../shared/db.ts';

/** `null` 一律表示「跟随上游」，不是 0。 */
export interface ModelSettingRow {
  channelPrefix: string;
  modelId: string;
  contextWindow: number | null;
  maxTokens: number | null;
  reasoningEffort: string | null;
}

/** `models` 为 `null` 表示不限（全部显示）。 */
export interface VisibilityRow {
  channelPrefix: string;
  listed: boolean;
  models: string[] | null;
}

const nullableNumber = (value: unknown): number | null => (typeof value === 'number' ? value : null);

export function listModelSettings(): ModelSettingRow[] {
  const rows = db
    .prepare('SELECT channel_prefix, model_id, context_window, max_tokens, reasoning_effort FROM model_setting')
    .all() as any[];
  return rows.map((row) => ({
    channelPrefix: String(row.channel_prefix),
    modelId: String(row.model_id),
    contextWindow: nullableNumber(row.context_window),
    maxTokens: nullableNumber(row.max_tokens),
    reasoningEffort: typeof row.reasoning_effort === 'string' ? row.reasoning_effort : null,
  }));
}

export function putModelSetting(row: ModelSettingRow): void {
  db.prepare(
    `INSERT OR REPLACE INTO model_setting
       (channel_prefix, model_id, context_window, max_tokens, reasoning_effort)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(row.channelPrefix, row.modelId, row.contextWindow, row.maxTokens, row.reasoningEffort);
}

export function deleteModelSetting(channelPrefix: string, modelId: string): void {
  db.prepare('DELETE FROM model_setting WHERE channel_prefix = ? AND model_id = ?').run(channelPrefix, modelId);
}

/** **没有行的通道就是默认值**（显示 + 不限），调用方按这个补齐；这里不替它编行——编出来的行会让人以为被显式配过。 */
export function listVisibility(): VisibilityRow[] {
  const rows = db.prepare('SELECT channel_prefix, listed, models FROM channel_visibility').all() as any[];
  return rows.map((row) => ({
    channelPrefix: String(row.channel_prefix),
    // SQLite 没有 boolean：存 0/1，读出来转回真布尔。
    listed: Number(row.listed) === 1,
    models: parseIds(row.models),
  }));
}

function parseIds(raw: unknown): string[] | null {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return null;
    // 去重但**保序**：清单的顺序就是模型列表的顺序。
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of value) {
      if (typeof id === 'string' && id !== '' && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    return out;
  } catch {
    return null;
  }
}

/** 调用方负责「全是默认值就删行」。 */
export function putVisibility(row: VisibilityRow): void {
  db.prepare(
    'INSERT OR REPLACE INTO channel_visibility (channel_prefix, listed, models) VALUES (?, ?, ?)',
  ).run(row.channelPrefix, row.listed ? 1 : 0, row.models === null ? null : JSON.stringify(row.models));
}

/** 「这个通道回到默认值」。 */
export function deleteVisibility(channelPrefix: string): void {
  db.prepare('DELETE FROM channel_visibility WHERE channel_prefix = ?').run(channelPrefix);
}
