// 版本号刷新：遍历所有通道，问它们各自的最新版本，写进库。
//
// **这个文件不认识任何具体通道**：谁实现了 `fetchIdentity()` 就问谁，没实现的跳过。
// 加通道时只要在通道对象上实现那个方法，这里一行都不用改。
//
// 取到的值只在**下次启动**生效（`identity` 是模块加载时读的）。这样做的理由：
// 运行中改 identity 会让同一进程里「刚发出去的请求」和「后面发的请求」带不同版本号，
// 上游看到的是混乱的指纹。重启一次（几十毫秒）比这个风险小。

import { channels } from '../channels/index.ts';
import { replaceVersions, lastFetchedAt, listVersions } from '../store/versions.ts';

/** 版本号多久重新拉一次。上游客户端自己也是几小时检查一次，太频繁会被风控标记。 */
export const VERSION_REFRESH_MS = 24 * 60 * 60 * 1000;

let log: (...args: unknown[]) => void = () => {};

export function setVersionsLogger(fn: (...args: unknown[]) => void): void {
  log = fn;
}

/** 这个通道该不该重新拉版本。 */
export function needsRefresh(channelId: string, now = Date.now()): boolean {
  const at = lastFetchedAt(channelId);
  if (at === null) return true;
  return now - at >= VERSION_REFRESH_MS;
}

/**
 * 问所有通道要最新版本并落库。**单个通道失败不影响其他通道**：上游接口偶尔 5xx 很正常，
 * 一个挂了不该让另外三个也拿不到。
 */
export async function refreshAllVersions(now = Date.now()): Promise<{ channelId: string; ok: boolean; error?: string }[]> {
  const results: { channelId: string; ok: boolean; error?: string }[] = [];

  for (const channel of channels) {
    if (typeof channel.fetchIdentity !== 'function') continue;
    if (!needsRefresh(channel.id, now)) {
      log(`version ${channel.id}: 未到刷新时间，跳过`);
      continue;
    }
    try {
      const patch = await channel.fetchIdentity();
      const entries = Object.entries(patch).filter(([, value]) => typeof value === 'string' && value !== '') as [string, string][];
      if (entries.length === 0) {
        // 空对象和「查失败」必须分开：前者是上游没给，后者要保留旧值。
        throw new Error('上游没有返回任何版本字段');
      }
      replaceVersions(channel.id, entries.map(([field, value]) => ({ field, value })), 'auto', now);
      log(`version ${channel.id}: ${entries.map(([k, v]) => `${k}=${v}`).join(' ')}`);
      results.push({ channelId: channel.id, ok: true });
    } catch (error: any) {
      log(`version ${channel.id} 拉取失败：${error?.message || error}（继续用库里的旧值）`);
      results.push({ channelId: channel.id, ok: false, error: error?.message || String(error) });
    }
  }

  return results;
}

/**
 * 启动时把库里缓存的版本号**就地写进通道的 `identity`**。
 *
 * 必须在 `channel.configure()` 之前调：`configure` 会把 `identity` 转发给各通道模块
 * （`configureTraeIdentity` / `configureWorkBuddy` 等），之后改 `identity` 就没用了。
 *
 * 直接改对象而不是返回新对象：`configure` 拿的是 `traeChannel.identity` 这个引用，
 * 换新对象它还是拿到旧的。
 */
export function applyCachedIdentities(): void {
  for (const channel of channels) {
    const rows = listVersions(channel.id);
    if (rows.length === 0) continue;
    for (const row of rows) {
      if (row.field in channel.identity) {
        (channel.identity as unknown as Record<string, string>)[row.field] = row.value;
      }
    }
    log(`version ${channel.id}: 用库里的缓存（${rows.map((r) => `${r.field}=${r.value}`).join(' ')}）`);
  }
}

/** 给 `/api/health` 用：这个通道的版本号是哪来的。 */
export function versionSourceOf(channelId: string): 'auto' | 'cached' | 'default' {
  const rows = listVersions(channelId);
  if (rows.length === 0) return 'default';
  const fresh = rows.some((row) => Date.now() - row.fetchedAt < VERSION_REFRESH_MS);
  return fresh ? 'auto' : 'cached';
}
