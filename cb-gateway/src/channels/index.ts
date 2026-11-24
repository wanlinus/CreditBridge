// 通道注册表。
//
// 网关不认识任何具体通道：它只遍历这里的数组，读每个通道自述的 `id` / `idPrefix`
// / `label`。所以加通道 = 新建目录 + `defineChannel` + 在这里加一行 import 和一个
// 数组项，路由层不用动。
//
// **没有「通道前缀路由」了**（v2）。v1 每个通道挂在自己的 `<prefix>` 下
// （`/workbuddy/v1/models`），v2 只剩 `/v1/*` 一个入口，通道靠模型 id 的前半段
// 认领：`wb-1/hy4free` 里的 `wb`。`idPrefix` 就是为此存在的。

import type { Channel } from '../types.ts';
import { workbuddyChannel } from './workbuddy/index.ts';
import { traeChannel } from './trae/index.ts';
import { qoderChannel } from './qoder/index.ts';
import { loomyChannel } from './loomy/index.ts';

/** 显示顺序就是这里的顺序：WorkBuddy 在前，和面板一贯的排法一致。 */
export const channels: Channel[] = [workbuddyChannel, traeChannel, qoderChannel, loomyChannel];

// 撞车不会抛异常，只会让一批请求静默走错上游（花错钱、进错账），所以在模块加载时
// 就检查。两样都要唯一：`id` 是账本/账号的归属键，`idPrefix` 是模型 id 的前半段。
const owners = new Map<string, Channel>();
for (const channel of channels) {
  for (const [kind, value] of [
    ['id', channel.id],
    ['idPrefix', channel.idPrefix],
  ] as const) {
    const key = `${kind}:${value}`;
    const owner = owners.get(key);
    if (owner) {
      throw new Error(`通道 ${owner.id} 和 ${channel.id} 的 ${kind} 撞车："${value}"，模型 id 会分不清`);
    }
    owners.set(key, channel);
  }
}


/** 按 id 找通道（账号的 `channelId`、账本里的 `provider`）。 */
export function channelById(id: string): Channel | undefined {
  return channels.find((channel) => channel.id === id);
}

/**
 * 按短前缀找通道（模型 id 的前半段）。
 *
 * `idPrefix` 的字符集由 `defineChannel` 校验，但**唯一性不在那**：`defineChannel`
 * 只看单个通道，撞车要到本文件顶部那个 `owners` 循环才会抛。两个通道撞前缀时
 * `wb-1/x` 会静默转给数组里靠前的那个，另一家的请求全走错上游——不报错，只花钱。
 */
export function channelByPrefix(prefix: string): Channel | undefined {
  return channels.find((channel) => channel.idPrefix === prefix);
}
