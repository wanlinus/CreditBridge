// 通道品牌图标：把 `src/channels/<id>/icon.png` 读成 data URI 交给前端。
//
// **不要在前端内联 base64**：2026-11 Loomy 上线后一直没图标，就是插件里那张内联表少了一行，
// 而注释还写着「缺了会退回首字母」，那段兜底实际不存在。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CHANNELS_DIR = path.join(__dirname, '..', 'channels');

const cache = new Map<string, string | null>();

/** 取某个通道的图标。文件缺失不抛错：图标是装饰，缺一张不该让整页失败。 */
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

export function resetChannelIconCacheForTests(): void {
  cache.clear();
}
