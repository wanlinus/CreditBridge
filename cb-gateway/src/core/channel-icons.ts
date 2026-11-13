import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CHANNELS_DIR = path.join(__dirname, '..', 'channels');

const cache = new Map<string, string | null>();

export function iconOf(channelId: string): string | null {
  const cached = cache.get(channelId);
  if (cached !== undefined) return cached;

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

export function letterOf(channel: { id: string; label: string }): string {
  const source = channel.label || channel.id;
  return source.slice(0, 1).toUpperCase();
}

export function resetChannelIconCacheForTests(): void {
  cache.clear();
}
