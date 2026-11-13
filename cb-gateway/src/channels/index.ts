import type { Channel } from '../types.ts';
import { workbuddyChannel } from './workbuddy/index.ts';
import { traeChannel } from './trae/index.ts';
import { qoderChannel } from './qoder/index.ts';
import { loomyChannel } from './loomy/index.ts';

export const channels: Channel[] = [workbuddyChannel, traeChannel, qoderChannel, loomyChannel];

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

export function channelById(id: string): Channel | undefined {
  return channels.find((channel) => channel.id === id);
}

export function channelByPrefix(prefix: string): Channel | undefined {
  return channels.find((channel) => channel.idPrefix === prefix);
}
