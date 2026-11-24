/**
 * 导航条上的两个计数（账号数、密钥数）。
 *
 * 做成模块级状态而不是 `ShellLayout` 自己发请求：后者只在挂载时拉一次，于是在密钥页
 * 新建一把 key 后导航条还是「密钥 0」，看起来像没建成。页面改完数据调一次 `refresh()`。
 *
 * 失败不报错：计数是装饰性信息，为它弹错误条比数字旧一会儿更烦人。
 */

import { ref } from 'vue';

import { api } from '@/api/client';

/** 账号数。`null` 表示还没拉到过（和「0 个」是两回事）。 */
export const accountCount = ref<number | null>(null);
export const keyCount = ref<number | null>(null);

let inFlight: Promise<void> | null = null;

/** 重新拉一次两个计数。并发调用合并成一次。 */
export function refreshNavCounts(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const [accounts, keys] = await Promise.all([
        api.get<{ accounts: unknown[] }>('/api/accounts'),
        api.get<{ keys: unknown[] }>('/api/keys'),
      ]);
      accountCount.value = Array.isArray(accounts?.accounts) ? accounts.accounts.length : 0;
      keyCount.value = Array.isArray(keys?.keys) ? keys.keys.length : 0;
    } catch {
      // 静默：401 已经由 client 跳登录页处理，其它错误不值得在导航条上吵。
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
