// 签到本地状态：一账号一条，`checkin_state` 表。它只管**幂等**。真实状态以上游状态接口和
// 只追加的 `checkin_log` 为准，所以它丢了只损失「今天可能重复领一次」，上游本身幂等。

import type { Account, CheckinRecord } from '../types.ts';
import { getCheckinState, putCheckinState } from '../store/checkin.ts';

export function readCheckinState(account: Pick<Account, 'id'>): CheckinRecord | null {
  return getCheckinState(account.id) as CheckinRecord | null;
}

/** 写失败**不抛**：签到本身已经成功，记不下来不该把成功变成失败。 */
export function writeCheckinState(account: Pick<Account, 'id'>, state: CheckinRecord): boolean {
  return putCheckinState(account.id, state);
}

/** 网络抖一下界面就说「今天没签」，而那条成功记录是唯一存着「今天得了多少积分」的地方。 */
export function keepEarlierSuccess(
  account: Pick<Account, 'id'>,
  today: string,
  next: CheckinRecord,
): CheckinRecord | null {
  const current = readCheckinState(account);
  if (current && current.date === today && current.status === 'checked' && next.status !== 'checked') return current;
  return null;
}
