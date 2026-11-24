// 上游版本号缓存（`channel_version`）——**唯一允许出现 SQL 的地方之一**。
//
// 上游升级后不让老客户端请求时，靠这张表把版本号跟上，不用改代码重新部署。
// 按 (通道, 字段) 存而不是一行 JSON：加字段不用改结构，且能单独标每个字段的取数时间。
//
// **只存「能自动更新」的字段**：换令牌的门禁字段（`clientVersion`）不进来，那个改了
// 可能触发上游校验，必须人看着改（见 `types.ts` 的 `IdentityPatch`）。

import { db } from '../shared/db.ts';

export interface VersionRow {
  channelId: string;
  field: string;
  value: string;
  /** `auto` 自动拉的 / `manual` 人工填的。 */
  source: string;
  fetchedAt: number;
}

export function listVersions(channelId?: string): VersionRow[] {
  const rows = channelId
    ? (db
        .prepare('SELECT channel_id, field, value, source, fetched_at FROM channel_version WHERE channel_id = ?')
        .all(channelId) as any[])
    : (db.prepare('SELECT channel_id, field, value, source, fetched_at FROM channel_version').all() as any[]);
  return rows.map((row) => ({
    channelId: String(row.channel_id),
    field: String(row.field),
    value: String(row.value),
    source: String(row.source),
    fetchedAt: Number(row.fetched_at) || 0,
  }));
}

/** 某个通道上次成功取数的时间；从没取过返回 `null`。 */
export function lastFetchedAt(channelId: string): number | null {
  const row = db
    .prepare('SELECT MAX(fetched_at) AS at FROM channel_version WHERE channel_id = ?')
    .get(channelId) as any;
  const at = Number(row?.at) || 0;
  return at > 0 ? at : null;
}

/**
 * 整批写入某个通道的版本号。**同一通道先删后插**：上游可能删掉某个字段，
 * 留着旧行会让「这个字段上游不给了」和「还没取到」分不清。
 */
export function replaceVersions(channelId: string, entries: { field: string; value: string }[], source: string, now = Date.now()): void {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM channel_version WHERE channel_id = ?').run(channelId);
    const insert = db.prepare(
      'INSERT INTO channel_version (channel_id, field, value, source, fetched_at) VALUES (?, ?, ?, ?, ?)',
    );
    for (const entry of entries) {
      insert.run(channelId, entry.field, entry.value, source, now);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
