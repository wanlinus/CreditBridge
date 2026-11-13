import { api } from './client';

interface ModelEntry {
  id: string;
  name?: string;
  context_length?: number;
  max_output_tokens?: number;
  reasoning?: boolean;
  [key: string]: unknown;
}

export interface ChannelCatalog {
  channelId: string;
  idPrefix: string;
  label: string;
  source: string | null;
  models: ModelEntry[];
  error: string | null;
  visible: string[] | null;
  listed: boolean;
  multiAccount: boolean;
}

export interface AccountCatalog {
  account: string;
  channelId: string;
  idPrefix: string;
  label: string;
  models: ModelEntry[];
  error: string | null;
  visible: string[] | null;
  listed: boolean;
}

export function getCatalog(): Promise<{ channels: ChannelCatalog[] }> {
  return api.get<{ channels: ChannelCatalog[] }>('/api/models/catalog');
}

export function getAccountCatalog(id: string): Promise<AccountCatalog> {
  return api.get<AccountCatalog>(`/api/models/catalog?account=${encodeURIComponent(id)}`);
}

export type VisibilityPatch =
  | { prefix: string; action: 'toggle-list'; listed: boolean }
  | { prefix: string; action: 'all' }
  | { prefix: string; visible: string[] };

export function saveVisibility(patch: VisibilityPatch): Promise<Record<string, unknown>> {
  return api.post<Record<string, unknown>>('/api/models/visibility', patch);
}
