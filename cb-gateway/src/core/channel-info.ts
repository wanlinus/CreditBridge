// 通道能力位与「取哪个号当样本」——跨路由反复出现的两个判断，只在这里定义。

import { accountsOf } from './accounts.ts';
import type { Account, Channel } from '../types.ts';

export interface ChannelCapabilities {
  canLogin: boolean;
  canLogout: boolean;
  canRotateDevice: boolean;
  canVerify: boolean;
  canCheckin: boolean;
}

/**
 * 能力位只能是 `typeof channel.x === 'function'`，不许按通道 id 分支。
 *
 * 三个响应（`/api/accounts` 的 `channels[]`、`/api/health` 的 `channels{}`、
 * `/api/accounts/:id` 的 `channel`）都从这里取；各抄一遍的话加第五个能力位时必然漏一处，
 * 而漏掉的表现是「那个按钮永远不显示」，三个响应看起来都对、类型也都过。
 */
export function capabilitiesOf(channel: Channel): ChannelCapabilities {
  return {
    canLogin: typeof channel.login === 'function',
    canLogout: typeof channel.logoutOf === 'function',
    canRotateDevice: typeof channel.rotateDeviceIdOf === 'function',
    canVerify: typeof channel.probe === 'function',
    canCheckin: typeof channel.checkinClaimOf === 'function',
  };
}

/** 优先 `ready`（坏凭据的号只回 401），其次第一个，都没有是 `null`。 */
export function primaryAccountOf(channelId: string): Account | null {
  const accounts = accountsOf(channelId);
  return accounts.find((account) => account.status === 'ready') ?? accounts[0] ?? null;
}
