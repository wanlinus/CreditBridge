// 签到历史：一行一次尝试，落在 `checkin_log` 表（只追加）。和「当天状态」分开——那个只存
// 当天、被下一次覆盖（幂等用），历史一旦覆盖就没了。
//
// 写日志的动作在**入口层**（调度器、手动领取），不在通道里：通道不该知道这次是自动还是手动。

import {
  appendCheckinLog as appendRow,
  clearCheckinLog,
  hasSkippedLog,
  listCheckinLog,
  type CheckinLogRow,
} from '../store/checkin.ts';

export type CheckinLogEntry = CheckinLogRow;

/** 写不进去就静默忽略：日志是审计，不是签到成功的必要条件。 */
export function appendCheckinLog(entry: CheckinLogEntry): void {
  try {
    appendRow(entry);
  } catch {
    // 同上：宁可丢一条审计，也不让成功的签到被记成失败。
  }
}

export function readCheckinLog(): CheckinLogEntry[] {
  return listCheckinLog();
}

/** 按本地日的起止毫秒查，不用 SQL 的 `date(ts)`——那个按 UTC 切日。 */
export function skippedLoggedToday(account: string, today: string): boolean {
  const [year, month, day] = today.split('-').map(Number);
  if (!year || !month || !day) return false;
  const start = new Date(year, month - 1, day).getTime();
  const end = new Date(year, month - 1, day + 1).getTime();
  try {
    return hasSkippedLog(account, start, end);
  } catch {
    return false;
  }
}

export function resetCheckinLogForTests(): void {
  clearCheckinLog();
}
