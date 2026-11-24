// 通道品牌图标：把 `src/channels/<id>/icon.png` 读成 data URI 交给前端。
//
// 图标是通道自己的资产，跟着通道目录走：加通道 = 丢一张 `icon.png` 进去，前端一处
// 也不用改。**不要在前端内联 base64**——2026-11 就因为这个让 Loomy 上线后一直没有
// 图标（插件里那张内联表少了一行，注释还写着「缺了会退回首字母」，而那段兜底不存在）。
//
// 用 data URI 而不是图片 URL：插件跑在 `dsh-app://` 下，`img-src` 放不放行网关源
// 没验证过，而 data URI 一直是通的。体积上也不吃亏（单张 1.4–8 KB，跟 `/api/channels`
// 一次返回、客户端缓存 5 分钟，不挂在 60 秒轮询的徽标接口上）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CHANNELS_DIR = path.join(__dirname, '..', 'channels');

/** 通道 id → data URI（`null` = 没有图标）。读一次就常驻，图标是打进镜像的静态文件。 */
const cache = new Map<string, string | null>();

/**
 * 取某个通道的图标；没有就返回 `null`。
 *
 * 文件缺失不抛错：图标是装饰，缺一张不该让 `/api/channels` 整个失败。前端拿到
 * `null` 时退回 `letter`。
 */
export function iconOf(channelId: string): string | null {
  const cached = cache.get(channelId);
  if (cached !== undefined) return cached;

  // 这个值拿来拼文件路径，多一道字符集校验比「假设调用方一定干净」便宜。
  if (!/^[a-z0-9-]+$/u.test(channelId)) {
    cache.set(channelId, null);
    return null;
  }

  let icon: string | null = null;
  try {
    const png = fs.readFileSync(path.join(CHANNELS_DIR, channelId, 'icon.png'));
    icon = `data:image/png;base64,${png.toString('base64')}`;
  } catch {
    icon = null;
  }
  cache.set(channelId, icon);
  return icon;
}

/** 通道名首字符，图标缺失时的兜底。放在网关算是因为它必须和 `label` 同源。 */
export function letterOf(channel: { id: string; label: string }): string {
  const source = channel.label || channel.id;
  return source.slice(0, 1).toUpperCase();
}

/** 测试用：清缓存。 */
export function resetChannelIconCacheForTests(): void {
  cache.clear();
}
