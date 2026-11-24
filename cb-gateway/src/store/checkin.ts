// 签到：当天状态（`checkin_state`）+ 历史日志（`checkin_log`）——**唯一允许出现 SQL 的地方之一**。
//
// 两张表分开是有意的，理由和文件时代一样：
//
//   · `checkin_state` 一天一条结论，**被下一次覆盖**（幂等用）；
//   · `checkin_log` 只追加，**历史不能覆盖**（审计用）。
//
// `checkin_state.account` 上有 `ON DELETE CASCADE`：删账号时当天状态跟着走。文件时代
// 这靠 `removeAccount()` 记得删文件，实测漏了（`tr-1` / `tr-2` 的账号早删了、文件还在）。
//
// 这里只做存取。**「失败的一次尝试不该抹掉当天早些时候的成功」这类规则留在
// `core/checkin-store.ts`**：那是策略。

import { db } from '../shared/db.ts';

/** 读某账号当天的状态 JSON（原样返回，字段属于 `CheckinRecord`，store 不认识它）。 */
export function getCheckinState(account: string): Record<string, any> | null {
  const row = db.prepare('SELECT state FROM checkin_state WHERE account = ?').get(account) as { state?: string } | undefined;
  if (!row || typeof row.state !== 'string' || row.state === '') return null;
  try {
    const value = JSON.parse(row.state);
    return value && typeof value === 'object' ? value : null;
  } catch {
    // 坏 JSON 当没有：签到状态坏了只损失「今天可能重复领一次」，上游本身幂等。
    return null;
  }
}

/** 写某账号当天的状态（覆盖）。账号不存在时会因外键失败——返回 false 而不是抛。 */
export function putCheckinState(account: string, state: unknown): boolean {
  try {
    db.prepare('INSERT OR REPLACE INTO checkin_state (account, state) VALUES (?, ?)').run(account, JSON.stringify(state));
    return true;
  } catch {
    // 账号已删（外键挂在 `account` 上）时写不进去，这属于正常情况：
    // 一个已经删掉的账号不该因为签到记录写失败而让整轮签到报错。
    return false;
  }
}

/** 一次签到尝试。字段和 `core/checkin-log.ts` 的 `CheckinLogEntry` 对齐。 */
export interface CheckinLogRow {
  ts: number;
  account: string;
  /** 通道 id（`workbuddy` / `trae` / `qoder`），给跨账号列表排序和分组用。 */
  channel: string;
  status: string;
  credits?: number | null;
  streakDays?: number | null;
  message?: string | null;
  /** `auto` = 调度器，`manual` = 用户在面板上手动点的。 */
  source: string;
}

/** 追加一条签到日志。 */
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

/**
 * 读签到日志，按时间**倒序**（界面要「最近的在上面」）。
 *
 * `limit` 有默认值：日志会一直长，而页面只看最近几条。给个上限是为了不让人某天
 * 顺手写出「把所有历史都读进内存」——那张表一年也就几千行，但没有上限的读取
 * 只会随时间长。
 */
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

/** 清空日志。**只给测试用**——生产数据不该被这个函数碰到。 */
export function clearCheckinLog(): void {
  db.prepare('DELETE FROM checkin_log').run();
}

/**
 * 这个账号今天有没有记过 `skipped`。按本地日的起止毫秒查。
 */
export function hasSkippedLog(account: string, dayStartMs: number, dayEndMs: number): boolean {
  const row = db
    .prepare('SELECT 1 AS hit FROM checkin_log WHERE account = ? AND status = ? AND ts >= ? AND ts < ? LIMIT 1')
    .get(account, 'skipped', dayStartMs, dayEndMs) as { hit?: number } | undefined;
  return Boolean(row);
}

// ---------------------------------------------------------------- 签到开关

/** 哪些账号被关掉了签到。返回关闭的集合——查不到就是开着。 */
export function listDisabledCheckinAccounts(): Set<string> {
  const rows = db.prepare('SELECT id FROM account WHERE checkin_enabled = 0').all() as any[];
  const out = new Set<string>();
  for (const row of rows) {
    if (typeof row.id === 'string' && row.id !== '') out.add(row.id);
  }
  return out;
}

/** 写账户级开关。返回是否真的改到了（账号不存在时 false）。 */
export function putCheckinAccount(accountId: string, enabled: boolean): boolean {
  const result = db.prepare('UPDATE account SET checkin_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, accountId);
  return Number(result.changes) > 0;
}
