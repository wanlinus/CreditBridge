import { api } from './client';

export type CheckinOutcome = 'checked' | 'already' | 'disabled' | 'pending' | 'error';

export interface CheckinLogEntry {
  ts: number;
  account: string;
  channel: string;
  status: CheckinOutcome;
  credits?: number | null;
  streakDays?: number | null;
  message?: string | null;
  source: 'auto' | 'manual';
}

export interface CheckinLogResponse {
  entries: CheckinLogEntry[];
  accountNames: Record<string, string>;
}

export function getCheckinLog(): Promise<CheckinLogResponse> {
  return api.get<CheckinLogResponse>('/api/checkin/log');
}

export interface CheckinAllResult {
  results: { account: string; channel: string; status: CheckinOutcome; credits?: number | null; message?: string }[];
  okCount: number;
  failCount: number;
}

export function checkinAll(): Promise<CheckinAllResult> {
  return api.post<CheckinAllResult>('/api/checkin/all');
}
