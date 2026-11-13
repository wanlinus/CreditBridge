import type { Channel } from '../types.ts';

const REQUIRED = ['id', 'idPrefix', 'label', 'identity', 'modelsOf', 'creditsOf', 'chatAs'] as const;

export function defineChannel(channel: Channel): Channel {
  const record = channel as unknown as Record<string, unknown>;
  for (const key of REQUIRED) {
    if (record[key] === undefined) throw new Error(`通道 ${String(record.id ?? '?')} 缺少必需成员：${key}`);
  }
  if (typeof channel.id !== 'string' || channel.id === '') throw new Error('通道的 id 必须是非空字符串');
  if (typeof channel.idPrefix !== 'string' || !/^[a-z0-9]+$/.test(channel.idPrefix)) {
    throw new Error(`通道 ${channel.id} 的 idPrefix 只能是小写字母和数字：${String(channel.idPrefix)}`);
  }
  if (typeof channel.identity !== 'object' || channel.identity === null) {
    throw new Error(`通道 ${channel.id} 的 identity 必须是对象`);
  }
  if (typeof channel.identity.clientVersion !== 'string' || channel.identity.clientVersion === '') {
    throw new Error(`通道 ${channel.id} 的 identity.clientVersion 必须是非空字符串`);
  }
  return channel;
}
