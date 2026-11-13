import { ref } from 'vue';

import { api } from '@/api/client';

export const accountCount = ref<number | null>(null);
export const keyCount = ref<number | null>(null);

let inFlight: Promise<void> | null = null;

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
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
