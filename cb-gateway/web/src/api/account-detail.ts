import { api } from './client';

export interface AccountDetail {
  account: {
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
    hasCredential: boolean;
    credentialSource: string | null;
    tokenExpiresAt: string | null;
  };
  channel: {
    id: string;
    label: string;
    idPrefix: string;
    identity: Record<string, string>;
    multiAccount: boolean;
    canLogin: boolean;
    canLogout: boolean;
    canRotateDevice: boolean;
    canVerify: boolean;
    canCheckin: boolean;
  };
}

interface CreditsPackage {
  name: string;
  limit: number;
  used: number;
  expireAt: number | null;
}

export interface CheckinRecord {
  date: string;
  status: 'checked' | 'already' | 'disabled' | 'error';
  credits?: number | null;
  extraCredits?: number;
  streakDays?: number | null;
  message?: string;
  at?: number;
  code?: number;
}

export interface CreditsView {
  provider: string;
  supported: boolean;
  totalRemain?: number;
  packages?: CreditsPackage[];
  account?: Record<string, unknown>;
  error?: string;
  label: string;
  idPrefix: string;
  checkin: CheckinRecord | null;
  loggedIn: boolean;
  canLogin: boolean;
  canLogout: boolean;
}

interface CheckinStatus {
  enable: boolean;
  checkedIn: boolean;
  credits: number;
  extraCredits: number;
  didCheckedIn?: boolean;
}

export interface CheckinEnvelope {
  ok: true;
  today: string;
  last: CheckinRecord | null;
  status: CheckinStatus | null;
  error?: string;
  canClaim: boolean;
}

export function getAccount(id: string): Promise<AccountDetail> {
  return api.get<AccountDetail>(`/api/accounts/${encodeURIComponent(id)}`);
}

export function getAccountCredits(id: string): Promise<CreditsView> {
  return api.get<CreditsView>(`/api/accounts/${encodeURIComponent(id)}/credits`);
}

export function getAccountCheckin(id: string): Promise<CheckinEnvelope> {
  return api.get<CheckinEnvelope>(`/api/accounts/${encodeURIComponent(id)}/checkin`);
}

export function claimCheckin(id: string): Promise<{ ok: boolean; result: CheckinRecord }> {
  return api.post<{ ok: boolean; result: CheckinRecord }>(`/api/accounts/${encodeURIComponent(id)}/checkin`);
}
