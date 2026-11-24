// 签到历史：一行一次尝试，落在 `checkin_log` 表（只追加）。
//
// 和「当天状态」分开：那个只存当天、被下一次覆盖，用来做幂等；历史一旦覆盖就没了。
//
// 写日志的动作在**入口层**（调度器、手动领取），不在通道里——通道的 `claimCheckin`
// 只负责「签一次 + 更新当天状态」，它不该知道这次是自动还是手动。

import {
  appendCheckinLog as appendRow,
  clearCheckinLog,
  hasSkippedLog,
  listCheckinLog,
  type CheckinLogRow,
} from '../store/checkin.ts';

export type CheckinLogEntry = CheckinLogRow;

/**
 * 追加一条日志。写不进去就静默忽略：日志是审计，不是签到成功的必要条件，
 * 为它把一次成功的签到变成失败不划算。
 */
export function appendCheckinLog(entry: CheckinLogEntry): void {
  try {
    appendRow(entry);
  } catch {
    // 同上：宁可丢一条审计，也不让成功的签到被记成失败。
  }
}

/** 读最近的日志，按时间倒序（store 已排好）。 */
export function readCheckinLog(): CheckinLogEntry[] {
  return listCheckinLog();
}

/**
 * 这个账号今天记过 `skipped` 没有。
 *
 * 调度器一天跑好几轮，每轮都会看到同一个被跳过的号，只在第一轮留痕。
 * 按本地日的起止毫秒查，不用 SQL 的 `date(ts)`——那个按 UTC 切日。
 */
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

/** 测试用。 */
export function resetCheckinLogForTests(): void {
  clearCheckinLog();
}
