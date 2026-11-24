// API key 表（`api_key`）——**唯一允许出现 SQL 的地方之一**。
//
// 这里只管存取。**校验、哈希、前缀、缓存全部留在 `core/keys.ts`**：那是策略
// （scrypt 参数、常量时间比对、内存快照），换存储不该动它们。
//
// ## 明文不落库（2026-11-22）
//
// `secret` 列已从表里物理删除（见 `shared/db.ts` 的 v2 迁移）。库里只有：
//
//   `salt` + `hash`  ——  scrypt 校验材料，不可逆
//   `prefix`         ——  明文前 12 字符，只为「列表上分清哪把是哪把」
//
// 明文只在 `POST /api/keys` 的响应里出现一次，之后任何地方都取不回来。
// 早先存明文是为了「忘了复制还能再看一眼」，代价是**库泄露 = key 泄露**，
// 而 key 泄露 = 别人的程序能以你的身份调所有模型。这个取舍不值。

import { db } from '../shared/db.ts';

export interface ApiKeyRecord {
  /** `k_xxxxxx`，稳定标识（页面操作、日志用），不是 secret。 */
  id: string;
  label: string;
  salt: string;
  hash: string;
  /** 明文前缀（`sk-` + 9 字符），页面展示用。 */
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  enabled: boolean;
  /** 预留：绑账号范围（`null` = 全部账号）。存 JSON 文本。 */
  accountScope: string[] | null;
}

/** 数据库行 → 领域对象。列名映射只有这一处。 */
function rowToRecord(row: any): ApiKeyRecord {
  return {
    id: String(row.id),
    label: row.label ?? '',
    salt: String(row.salt ?? ''),
    hash: String(row.hash ?? ''),
    prefix: row.prefix ?? '',
    createdAt: Number(row.created_at) || 0,
    lastUsedAt: row.last_used_at === null || row.last_used_at === undefined ? null : Number(row.last_used_at),
    // SQLite 没有 boolean：存 0/1，读出来必须转回真布尔，否则 `enabled === false` 永远是 false。
    enabled: Number(row.enabled) === 1,
    accountScope: parseScope(row.account_scope),
  };
}

function parseScope(raw: unknown): string[] | null {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.map(String) : null;
  } catch {
    // 坏 JSON 当成「不限制」，不要让一把 key 因为一个坏字段整个失效。
    return null;
  }
}

function serializeScope(scope: string[] | null): string | null {
  return Array.isArray(scope) ? JSON.stringify(scope) : null;
}

/** 全部 key，按创建时间升序——列表页的顺序就是这个。 */
export function listKeys(): ApiKeyRecord[] {
  const rows = db.prepare('SELECT * FROM api_key ORDER BY created_at').all() as any[];
  return rows.map(rowToRecord);
}

/** 按 id 找一把；找不到返回 `null`。 */
export function findKey(id: string): ApiKeyRecord | null {
  const row = db.prepare('SELECT * FROM api_key WHERE id = ?').get(id) as any;
  return row ? rowToRecord(row) : null;
}

/**
 * 按明文前缀找启用的 key。
 *
 * 校验时用它把候选从「全表」降到「通常 1 条」。前缀只有 12 字符、区分度不高
 * （理论上可能撞），所以**返回数组**由调用方逐条比对，不要假设唯一。
 *
 * 走 `idx_api_key_prefix` 索引；表小的时候和全表扫差不多（实测都 0.03ms），
 * 但 key 变多时不会退化。
 */
export function findEnabledKeysByPrefix(prefix: string): ApiKeyRecord[] {
  const rows = db.prepare('SELECT * FROM api_key WHERE enabled = 1 AND prefix = ?').all(prefix) as any[];
  return rows.map(rowToRecord);
}

/** 新建。冲突直接抛（id 是随机 8 位 hex，撞了就该当场知道）。 */
export function insertKey(record: ApiKeyRecord): void {
  db.prepare(
    `INSERT INTO api_key
       (id, label, salt, hash, prefix, created_at, last_used_at, enabled, account_scope)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.label,
    record.salt,
    record.hash,
    record.prefix,
    record.createdAt,
    record.lastUsedAt,
    // **布尔必须转 0/1**：直接绑 `true` 会抛 `Provided value cannot be bound`。
    record.enabled ? 1 : 0,
    serializeScope(record.accountScope),
  );
}

/** 改标签 / 停用。字段名是白名单拼出来的，值仍然走 `?` 占位。 */
export function updateKeyRow(id: string, patch: { label?: string; enabled?: boolean }): ApiKeyRecord | null {
  const sets: string[] = [];
  const params: (string | number)[] = [];
  if (patch.label !== undefined) {
    sets.push('label = ?');
    params.push(patch.label);
  }
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?');
    params.push(patch.enabled ? 1 : 0);
  }
  if (sets.length > 0) {
    params.push(id);
    db.prepare(`UPDATE api_key SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }
  return findKey(id);
}

/** 删一把。返回「是否真的删到了」——删不存在的 id 不该报错。 */
export function deleteKeyRow(id: string): boolean {
  const result = db.prepare('DELETE FROM api_key WHERE id = ?').run(id);
  return Number(result.changes) > 0;
}

/**
 * 记一次「最后使用时间」。
 *
 * 节流在 `core/keys.ts` 做（每分钟最多一次）：这是给人看的字段，不值得每个请求写库，
 * 而写库会持有写锁。
 */
export function touchKey(id: string, at: number): void {
  db.prepare('UPDATE api_key SET last_used_at = ? WHERE id = ?').run(at, id);
}

/** 有没有任何启用的 key。启动日志要提醒「去 /keys 建一把」。 */
export function hasEnabledKey(): boolean {
  const row = db.prepare('SELECT COUNT(*) AS n FROM api_key WHERE enabled = 1').get() as { n?: number } | undefined;
  return (Number(row?.n) || 0) > 0;
}
