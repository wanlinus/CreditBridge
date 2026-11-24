// 通道能力位与「取哪个号当样本」——跨路由反复出现的两个判断，只在这里定义。

import { accountsOf } from './accounts.ts';
import type { Account, Channel } from '../types.ts';

/**
 * 通道自述的能力位。
 *
 * **判断方式只能是 `typeof channel.x === 'function'`**：通道用「有没有实现这个可选
 * 方法」表达能力，网关和界面都不许按通道 id 分支。
 *
 * 三个响应（`/api/accounts` 的 `channels[]`、`/api/health` 的 `channels{}`、
 * `/api/accounts/:id` 的 `channel`）都从这里取。各抄一遍的话，加第五个能力位时必然
 * 漏一处，而漏掉的表现是「那个按钮永远不显示」，三个响应看起来都对、类型也都过。
 */
export interface ChannelCapabilities {
  canLogin: boolean;
  canLogout: boolean;
  canRotateDevice: boolean;
  canVerify: boolean;
  canCheckin: boolean;
}

export function capabilitiesOf(channel: Channel): ChannelCapabilities {
  return {
    canLogin: typeof channel.login === 'function',
    canLogout: typeof channel.logoutOf === 'function',
    canRotateDevice: typeof channel.rotateDeviceIdOf === 'function',
    canVerify: typeof channel.probe === 'function',
    canCheckin: typeof channel.checkinClaimOf === 'function',
  };
}

/**
 * 拿这个通道的哪个号去问上游（模型目录、档位表、档位校验）。
 *
 * 优先 `ready`：坏凭据的号只回 401，整块目录会报错，看起来像通道坏了。没有 ready
 * 就退回第一个；一个号都没有是 `null`（调用方显示「还没加号」，不是错误）。
 *
 * `/api/models/catalog` 和 `POST /api/models/settings` 共用它——两处各写一遍会导致
 * 「目录页能列模型、设置页存不进去」这种半坏状态。
 */
export function primaryAccountOf(channelId: string): Account | null {
  const accounts = accountsOf(channelId);
  return accounts.find((account) => account.status === 'ready') ?? accounts[0] ?? null;
}
