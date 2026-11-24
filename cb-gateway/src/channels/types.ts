// 通道契约的运行时校验。
//
// 形状定义在 `../types.ts` 的 `Channel`；`defineChannel` 在 import 时就校验必需成员，
// 让字段拼错在启动时报错，而不是变成某个路由的 404。

import type { Channel } from '../types.ts';

// 必需成员就是 `Channel` 接口上不带 `?` 的那七个，`checkinStatusOf` 不在其中：
// 它在接口上是可选的，上游有状态接口的通道实现它、没有的返回 `null`（WorkBuddy 就
// 是这条），Loomy 干脆不实现。这里只兜「字段拼错 / 漏写必需成员」，不替 tsc 复查
// 可选成员——把可选成员也塞进来会误伤 Loomy，启动直接抛错。
const REQUIRED = ['id', 'idPrefix', 'label', 'identity', 'modelsOf', 'creditsOf', 'chatAs'] as const;

export function defineChannel(channel: Channel): Channel {
  const record = channel as unknown as Record<string, unknown>;
  for (const key of REQUIRED) {
    if (record[key] === undefined) throw new Error(`通道 ${String(record.id ?? '?')} 缺少必需成员：${key}`);
  }
  if (channel.id === '') throw new Error('通道的 id 必须是非空字符串');
  // `idPrefix` 是模型 id 的前半段（`wb-1/hy4free` 里的 `wb`），按第一个 `-` 切出来。
  // 它自己再带 `-` 就切不开了，带 `/` 会被当成 id 的分隔符，所以这里的字符集是硬约束。
  if (!/^[a-z0-9]+$/.test(channel.idPrefix)) {
    throw new Error(`通道 ${channel.id} 的 idPrefix 只能是小写字母和数字：${String(channel.idPrefix)}`);
  }
  // 版本号写空的后果很隐蔽：上游只会回一句「客户端太旧」或者干脆 401，看起来像
  // 签名/鉴权问题。这里当场拦住，比在生产日志里猜三天强。
  if (typeof channel.identity !== 'object' || channel.identity === null) {
    throw new Error(`通道 ${channel.id} 的 identity 必须是对象`);
  }
  if (channel.identity.clientVersion === '') {
    throw new Error(`通道 ${channel.id} 的 identity.clientVersion 必须是非空字符串`);
  }
  return channel;
}
