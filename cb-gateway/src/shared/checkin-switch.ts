// 账号级签到开关。只管「要不要自动签」，不碰对话和余额。
//
// 和 `account.status = 'disabled'` 不是一回事：那个是整个号不用了，这个只管签到。
//
// 缓存一份索引：`/api/accounts` 要给每个账号算一遍，不缓存就是每请求几十次 SQL。

import { listDisabledCheckinAccounts } from '../store/checkin.ts';

let disabledAccounts: Set<string> | null = null;

function accountIndex(): Set<string> {
  if (disabledAccounts === null) disabledAccounts = listDisabledCheckinAccounts();
  return disabledAccounts;
}

/** 这个号要不要自动签到。 */
export function checkinEnabledOfAccount(accountId: string): boolean {
  return !accountIndex().has(accountId);
}

/**
 * 写开关后让索引失效。
 *
 * 落库走 `core/accounts.ts` 的 `setAccountCheckinEnabled()`（那边有内存副本），
 * 这里只清自己的缓存——`shared/` 不 import `core/`。
 */
export function invalidateCheckinSwitchCache(): void {
  disabledAccounts = null;
}

/** 测试用。 */
export function resetCheckinSwitchCacheForTests(): void {
  disabledAccounts = null;
}
