import { api } from './client';

export interface ApiKey {
  id: string;
  label: string;
  secret: string | null;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  enabled: boolean;
  accountScope: string[] | null;
}

export function getKeys(): Promise<{ keys: ApiKey[] }> {
  return api.get<{ keys: ApiKey[] }>('/api/keys');
}

export function createKey(label: string): Promise<{ key: ApiKey; secret: string }> {
  return api.post<{ key: ApiKey; secret: string }>('/api/keys', { label });
}

export function updateKey(id: string, patch: { label?: string; enabled?: boolean }): Promise<{ ok: true; key: ApiKey }> {
  return api.patch<{ ok: true; key: ApiKey }>(`/api/keys/${encodeURIComponent(id)}`, patch);
}

export function deleteKey(id: string): Promise<{ ok: true; removed: string }> {
  return api.delete<{ ok: true; removed: string }>(`/api/keys/${encodeURIComponent(id)}`);
}
