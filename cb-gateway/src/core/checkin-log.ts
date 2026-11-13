import fs from 'node:fs';
import path from 'node:path';

import { STATE_DIR } from '../shared/paths.ts';

const LOG_PATH = path.join(STATE_DIR, 'checkin-log.jsonl');

export interface CheckinLogEntry {
  ts: number;
  account: string;
  channel: string;
  status: string;
  credits?: number | null;
  streakDays?: number | null;
  message?: string | null;
  source: 'auto' | 'manual';
}

export function appendCheckinLog(entry: CheckinLogEntry): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (error: any) {
  }
}

export function readCheckinLog(): CheckinLogEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(LOG_PATH, 'utf8');
  } catch {
    return [];
  }
  const out: CheckinLogEntry[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry.account === 'string' && typeof entry.ts === 'number') {
        out.push(entry);
      }
    } catch {
    }
  }
  return out.sort((a, b) => b.ts - a.ts);
}

export function resetCheckinLogForTests(): void {
  try {
    fs.rmSync(LOG_PATH, { force: true });
  } catch {
  }
}
