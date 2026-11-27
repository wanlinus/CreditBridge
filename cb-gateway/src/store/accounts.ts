// 上游账号表（`account` + `account_seq`）——**唯一允许出现 SQL 的地方之一**。这里只管存取，
// 状态机、序号分配、凭据刷新、并发单飞全部留在 `core/accounts.ts`。
//
// 两条不变量由结构保证：① `account_seq` 是**只增不减**的游标，和 `account` 分开存——只看现存
// 账号的话，删掉 3 号之后新加的号会拿到 3，账本里那批「旧的 3 号」的历史会算到新号头上；
// ② `UNIQUE(channel_id, seq)` 让序号撞车当场抛，而不是两个账号共用一号。

import { db } from '../shared/db.ts';
import type { Account, AccountStatus } from '../types.ts';

const STATUSES: AccountStatus[] = ['ready', 'invalid', 'disabled'];

/** 列名映射只有这一处；JSON 文本在这里解析回对象。 */
function rowToAccount(row: any): Account | null {
  const status = STATUSES.includes(row.status) ? (row.status as AccountStatus) : 'invalid';
  const seq = Number(row.seq);
  if (typeof row.id !== 'string' || row.id === '') return null;
  if (typeof row.channel_id !== 'string' || row.channel_id === '') return null;
  if (!Number.isInteger(seq) || seq <= 0) return null;
  return {
    id: row.id,
    channelId: row.channel_id,
    seq,
    label: typeof row.label === 'string' && row.label !== '' ? row.label : row.id,
    credential: parseJson(row.credential),
    status,
    statusMessage: typeof row.status_message === 'string' ? row.status_message : null,
    profile: parseObject(row.profile),
    // 老行拿到的是列默认值 1；`!== 0` 比 `=== 1` 宽容，手改库写成 2 也不会把签到静默关掉。
    checkinEnabled: Number(row.checkin_enabled) !== 0,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

/** 凭据是通道自己的形状，原样解析。坏 JSON 当没有。 */
function parseJson(raw: unknown): any {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseObject(raw: unknown): Record<string, any> {
  const value = parseJson(raw);
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function listAccounts(): Account[] {
  const rows = db.prepare('SELECT * FROM account ORDER BY channel_id, seq').all() as any[];
  const out: Account[] = [];
  for (const row of rows) {
    const account = rowToAccount(row);
    if (account) out.push(account);
  }
  return out;
}

/** 凭据和 profile 序列化成 JSON 文本——四个通道的字段完全不同。 */
export function upsertAccount(account: Account): void {
  db.prepare(
    `INSERT OR REPLACE INTO account
       (id, channel_id, seq, label, credential, status, status_message, profile, checkin_enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    account.id,
    account.channelId,
    account.seq,
    account.label,
    account.credential === null || account.credential === undefined ? null : JSON.stringify(account.credential),
    account.status,
    account.statusMessage,
    JSON.stringify(account.profile || {}),
    // SQLite 没有 boolean：存 0/1。`INSERT OR REPLACE` 会整行覆盖，所以调用方必须把现有的
    // checkinEnabled 一起传进来，否则一次状态更新就会把开关重置。
    account.checkinEnabled === false ? 0 : 1,
    account.createdAt,
    account.updatedAt,
  );
}

/** 签到状态由外键级联删除——文件时代漏删过状态文件。 */
export function deleteAccount(id: string): boolean {
  const result = db.prepare('DELETE FROM account WHERE id = ?').run(id);
  return Number(result.changes) > 0;
}

/** 读序号游标；没有就是 0。 */
export function readSeqCursor(channelId: string): number {
  const row = db.prepare('SELECT seq FROM account_seq WHERE channel_id = ?').get(channelId) as { seq?: number } | undefined;
  const value = Number(row?.seq);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

/** 只增不减——调用方传更小的值时这里会拒绝（返回实际生效的值）。 */
export function writeSeqCursor(channelId: string, seq: number): number {
  const current = readSeqCursor(channelId);
  const next = Math.max(current, seq);
  db.prepare(
    'INSERT INTO account_seq (channel_id, seq) VALUES (?, ?) ON CONFLICT(channel_id) DO UPDATE SET seq = ?',
  ).run(channelId, next, next);
  return next;
}
