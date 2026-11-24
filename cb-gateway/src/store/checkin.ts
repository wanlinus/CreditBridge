// 签到：当天状态（`checkin_state`）+ 历史日志（`checkin_log`）——**唯一允许出现 SQL 的地方之一**。
//
// 两张表分开是有意的：`checkin_state` 一天一条结论、**被下一次覆盖**（幂等用）；`checkin_log`
// 只追加、**历史不能覆盖**（审计用）。`checkin_state` 上有 `ON DELETE CASCADE`——文件时代这
// 靠 `removeAccount()` 记得删文件，实测漏了。

import { db } from '../shared/db.ts';

/** 原样返回，字段属于 `CheckinRecord`，store 不认识它。 */
export function getCheckinState(account: string): Record<string, any> | null {
  const row = db.prepare('SELECT state FROM checkin_state WHERE account = ?').get(account) as { state?: string } | undefined;
  if (!row || typeof row.state !== 'string' || row.state === '') return null;
  try {
    const value = JSON.parse(row.state);
    return value && typeof value === 'object' ? value : null;
  } catch {
    // 坏 JSON 当没有：签到状态坏了只损失「今天可能重复领一次」。
    return null;
  }
}

/** 账号不存在时会因外键失败——返回 false 而不是抛。 */
export function putCheckinState(account: string, state: unknown): boolean {
  try {
    db.prepare('INSERT OR REPLACE INTO checkin_state (account, state) VALUES (?, ?)').run(account, JSON.stringify(state));
    return true;
  } catch {
    // 账号已删（外键挂在 `account` 上）时写不进去属于正常情况。
    return false;
  }
}

/** 一次签到尝试，和 `core/checkin-log.ts` 的 `CheckinLogEntry` 对齐。 */
export interface CheckinLogRow {
  ts: number;
  account: string;
  /** 通道 id，给跨账号列表排序和分组用。 */
  channel: string;
  status: string;
  credits?: number | null;
  streakDays?: number | null;
  message?: string | null;
  /** `auto` = 调度器，`manual` = 用户在面板上手动点的。 */
  source: string;
}

export function appendCheckinLog(row: CheckinLogRow): void {
  db.prepare(
    `INSERT INTO checkin_log (ts, account, channel, status, credits, streak_days, message, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.ts,
    row.account,
    row.channel,
    row.status,
    row.credits ?? null,
    row.streakDays ?? null,
    row.message ?? null,
    row.source,
  );
}

/** 按时间**倒序**。`limit` 有默认值是为了不让人顺手写出「把历史全读进内存」。 */
export function listCheckinLog(limit = 500): CheckinLogRow[] {
  const rows = db
    .prepare(
      `SELECT ts, account, channel, status, credits, streak_days, message, source
         FROM checkin_log ORDER BY ts DESC, id DESC LIMIT ?`,
    )
    .all(limit) as any[];
  return rows.map((row) => ({
    ts: Number(row.ts) || 0,
    account: String(row.account ?? ''),
    channel: String(row.channel ?? ''),
    status: String(row.status ?? ''),
    credits: row.credits === null ? null : Number(row.credits),
    streakDays: row.streak_days === null ? null : Number(row.streak_days),
    message: row.message ?? null,
    source: String(row.source ?? ''),
  }));
}

/** **只给测试用**——生产数据不该被这个函数碰到。 */
export function clearCheckinLog(): void {
  db.prepare('DELETE FROM checkin_log').run();
}

/** 按本地日的起止毫秒查。 */
export function hasSkippedLog(account: string, dayStartMs: number, dayEndMs: number): boolean {
  const row = db
    .prepare('SELECT 1 AS hit FROM checkin_log WHERE account = ? AND status = ? AND ts >= ? AND ts < ? LIMIT 1')
    .get(account, 'skipped', dayStartMs, dayEndMs) as { hit?: number } | undefined;
  return Boolean(row);
}

/** 哪些账号被关掉了签到。查不到就是开着。 */
export function listDisabledCheckinAccounts(): Set<string> {
  const rows = db.prepare('SELECT id FROM account WHERE checkin_enabled = 0').all() as any[];
  const out = new Set<string>();
  for (const row of rows) {
    if (typeof row.id === 'string' && row.id !== '') out.add(row.id);
  }
  return out;
}

/** 账号不存在时返回 false。 */
export function putCheckinAccount(accountId: string, enabled: boolean): boolean {
  const result = db.prepare('UPDATE account SET checkin_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, accountId);
  return Number(result.changes) > 0;
}
