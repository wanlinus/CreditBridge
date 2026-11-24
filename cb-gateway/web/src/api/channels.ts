/**
 * 通道外观（`GET /api/channels`）。
 *
 * 图标由网关给（读 `channels/<name>/icon.png` 转 data URI），前端不留通道清单、也不
 * 内联 base64。缺图时用 `letter` 兜底——那个兜底真的在响应里，不是前端猜的。
 *
 * 可以缓存 5 分钟（网关侧带了 `max-age=300`），而 `/api/health` 一秒都不能缓存。
 */
import { api } from './client';

export interface ChannelAppearance {
  id: string;
  label: string;
  idPrefix: string;
  /** 图标缺失时的兜底字符（通道名首字）。 */
  letter: string;
  /** PNG 的 data URI；没有图标时是 `null`。 */
  icon: string | null;
}

export function getChannels(): Promise<{ channels: ChannelAppearance[] }> {
  return api.get<{ channels: ChannelAppearance[] }>('/api/channels');
}

/**
 * 把通道清单转成「通道 id + 名字 → 图标/兜底字母」的查表函数。
 *
 * 账号页、概览页、模型页都要这个，原先各写一遍 `new Map(...)` 加一条三行的空值兜底链。
 * 任何一处少写一段，那个页面的图标就静默变空白（2026-11 Loomy 一直没图标就是这个）。
 *
 * 返回的 `look` 永远可用：没有外观数据时 `icon` 是 `null`、`letter` 用名字兜底，
 * 页面不用再写 `??` 链。
 */
export interface ChannelLook {
  /** PNG 的 data URI；没有图标时是 `null`（`ChannelIcon` 会退回 `letter`）。 */
  icon: string | null;
  /** 图标缺失时显示的字符。 */
  letter: string;
}

export function looksOf(channels: readonly ChannelAppearance[] | null | undefined): (channelId: string, label: string) => ChannelLook {
  const map = new Map<string, ChannelAppearance>();
  for (const channel of channels ?? []) map.set(channel.id, channel);
  return (channelId, label) => {
    const hit = map.get(channelId);
    return {
      icon: hit?.icon ?? null,
      // 兜底字母取 `label` 的第一个字，而不是 `id`：用户看到的是「WorkBuddy」，
      // 拿 `w` 去代表它没有意义。
      letter: hit?.letter ?? (label || channelId).slice(0, 1).toUpperCase(),
    };
  };
}
