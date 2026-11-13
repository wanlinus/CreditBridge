import { api } from './client';

export interface AccountRow {
  id: string;
  channelId: string;
  channelLabel: string;
  idPrefix: string;
  seq: number;
  label: string;
  status: string;
  statusMessage: string | null;
  cooldownUntil: number | null;
  profile: { uid?: string | null; username?: string | null; domain?: string | null } | null;
  createdAt: number;
  totalRemain: number | null;
  usedTotal: number | null;
  limitTotal: number | null;
  prevRemain: number | null;
  prevAt: number | null;
  creditsAt: number | null;
  todayTokens: number;
  totalTokens: number;
}

export interface ChannelCapability {
  id: string;
  label: string;
  idPrefix: string;
  multiAccount: boolean;
  canLogin: boolean;
  canLogout: boolean;
  canRotateDevice: boolean;
  canVerify: boolean;
  reportsTokens: boolean;
  accounts: string[];
}

export interface AccountsResponse {
  accounts: AccountRow[];
  channels: ChannelCapability[];
}

export function getAccounts(): Promise<AccountsResponse> {
  return api.get<AccountsResponse>('/api/accounts');
}

interface LoginPrompt {
  id: string;
  label: string;
  placeholder?: string;
  inputType?: 'text' | 'number' | 'password';
  submitLabel?: string;
}

export interface LoginTask {
  taskId: string;
  channelId: string;
  state: 'running' | 'done' | 'error' | 'cancelled';
  url: string | null;
  prompt: LoginPrompt | null;
  message: string | null;
  startedAt: number;
  finishedAt: number | null;
  accountId: string | null;
}

export function startLogin(channelId: string): Promise<{ ok: true; task: LoginTask }> {
  return api.post<{ ok: true; task: LoginTask }>(`/api/accounts/${encodeURIComponent(channelId)}/login`);
}

export function getLoginTask(channelId: string, taskId: string): Promise<LoginTask> {
  return api.get<LoginTask>(
    `/api/accounts/${encodeURIComponent(channelId)}/login/${encodeURIComponent(taskId)}`,
  );
}

export function answerLoginPrompt(channelId: string, taskId: string, value: string): Promise<{ ok: true }> {
  return api.post<{ ok: true }>(
    `/api/accounts/${encodeURIComponent(channelId)}/login/${encodeURIComponent(taskId)}/answer`,
    { value },
  );
}

export function cancelLoginTask(
  channelId: string,
  taskId: string,
): Promise<{ ok: true; cancelled: boolean; existed: boolean }> {
  return api.delete<{ ok: true; cancelled: boolean; existed: boolean }>(
    `/api/accounts/${encodeURIComponent(channelId)}/login/${encodeURIComponent(taskId)}`,
  );
}

export function verifyAccount(id: string): Promise<{ ok: true; profile: Record<string, unknown> }> {
  return api.post<{ ok: true; profile: Record<string, unknown> }>(`/api/accounts/${encodeURIComponent(id)}/verify`);
}

export function patchAccount(
  id: string,
  patch: { label?: string; status?: 'disabled' | 'ready' },
): Promise<{ ok: true; account: unknown }> {
  return api.patch<{ ok: true; account: unknown }>(`/api/accounts/${encodeURIComponent(id)}`, patch);
}

export function deleteAccount(id: string): Promise<{ ok: true; removed: string }> {
  return api.delete<{ ok: true; removed: string }>(`/api/accounts/${encodeURIComponent(id)}`);
}

export function logoutAccount(
  id: string,
): Promise<{ ok: true; upstream: string | null; removed: false }> {
  return api.post<{ ok: true; upstream: string | null; removed: false }>(
    `/api/accounts/${encodeURIComponent(id)}/logout`,
  );
}

export function rotateDevice(
  id: string,
): Promise<{ ok: true; changed: boolean; fields?: string[]; reason?: string }> {
  return api.post<{ ok: true; changed: boolean; fields?: string[]; reason?: string }>(
    `/api/accounts/${encodeURIComponent(id)}/rotate-device`,
  );
}
