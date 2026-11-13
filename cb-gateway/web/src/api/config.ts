import { api, request } from './client';

export interface Health {
  ok: boolean;
  gateway: string;
  version: string;
  startedAt: string;
  checkinTime: string;
  modelIdFormat: string;
  channels: Record<string, HealthChannel>;
  accounts: HealthAccount[];
}

interface HealthChannel {
  id: string;
  label: string;
  idPrefix: string;
  identity: Record<string, string>;
  listed: boolean;
  multiAccount: boolean;
  canLogin: boolean;
  canLogout: boolean;
  canRotateDevice: boolean;
  canVerify: boolean;
  accounts: string[];
}

interface HealthAccount {
  id: string;
  channelId: string;
  channelLabel: string;
  idPrefix: string;
  label: string;
  status: string;
  statusMessage: string | null;
  cooldownUntil: number | null;
  uid: string | null;
  username: string | null;
  hasCredential: boolean;
  createdAt: number;
}

export function getHealth(): Promise<Health> {
  return api.get<Health>('/api/health');
}

export async function login(username: string, password: string): Promise<{ ok: boolean; mustChangePassword: boolean }> {
  return request('/api/login', {
    method: 'POST',
    body: { username, password },
    skipAuthRedirect: true,
  });
}

export async function changePassword(current: string, next: string, confirm: string): Promise<{ ok: boolean }> {
  return request('/api/password', {
    method: 'POST',
    body: { current, next, confirm },
    skipAuthRedirect: true,
  });
}

export function logout(): Promise<{ ok: boolean; removed: boolean }> {
  return request('/api/logout', { method: 'POST', skipAuthRedirect: true });
}

export function updateConfig(patch: { checkinTime: string }): Promise<{ ok: true; checkinTime: string }> {
  return request('/api/config', { method: 'PATCH', body: patch });
}
