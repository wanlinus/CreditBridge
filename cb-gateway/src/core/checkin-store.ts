// 签到本地状态：一账号一条，`checkin_state` 表。
//
// 它只管**幂等**：同一天成功过一次就别再打上游。真实状态以上游状态接口和只追加的
// `checkin_log` 为准，所以它丢了也只损失「今天可能重复领一次」，上游本身幂等。

import type { Account, CheckinRecord } from '../types.ts';
import { getCheckinState, putCheckinState } from '../store/checkin.ts';

/** 没有、或者 JSON 坏了，都返回 `null`。 */
export function readCheckinState(account: Pick<Account, 'id'>): CheckinRecord | null {
  return getCheckinState(account.id) as CheckinRecord | null;
}

/**
 * 写本地签到记录。写失败**不抛**：签到本身已经成功，记不下来只是下次可能再打一次
 * 上游，不该把一次成功的签到变成失败。
 */
export function writeCheckinState(account: Pick<Account, 'id'>, state: CheckinRecord): boolean {
  return putCheckinState(account.id, state);
}

/**
 * 「失败的一次尝试不该抹掉当天早些时候的成功记录」。
 *
 * 这条规则三个通道都要：网络抖一下界面就说「今天没签」，而那条成功记录是唯一存着
 * 「今天得了多少积分」的地方。
 *
 * @returns 该保留的旧记录；没有可保留的返回 `null`（调用方照常写新记录）。
 */
export function keepEarlierSuccess(
  account: Pick<Account, 'id'>,
  today: string,
  next: CheckinRecord,
): CheckinRecord | null {
  const current = readCheckinState(account);
  if (current && current.date === today && current.status === 'checked' && next.status !== 'checked') return current;
  return null;
}
