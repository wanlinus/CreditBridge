import fs from 'node:fs';
import path from 'node:path';

import type { Account, CheckinRecord } from '../types.ts';
import { CHECKIN_DIR } from '../shared/paths.ts';
import { writeFileAtomic } from '../shared/atomic-write.ts';

function checkinPath(account: Pick<Account, 'id'>): string {
  return path.join(CHECKIN_DIR, `${account.id}.json`);
}

export function readCheckinState(account: Pick<Account, 'id'>): CheckinRecord | null {
  try {
    const doc = JSON.parse(fs.readFileSync(checkinPath(account), 'utf8'));
    return doc && typeof doc === 'object' ? (doc as CheckinRecord) : null;
  } catch {
    return null;
  }
}

export function writeCheckinState(account: Pick<Account, 'id'>, state: CheckinRecord): boolean {
  try {
    writeFileAtomic(checkinPath(account), JSON.stringify(state, null, 2));
    return true;
  } catch {
    return false;
  }
}

export function keepEarlierSuccess(
  account: Pick<Account, 'id'>,
  today: string,
  next: CheckinRecord,
): CheckinRecord | null {
  const current = readCheckinState(account);
  if (current && current.date === today && current.status === 'checked' && next.status !== 'checked') return current;
  return null;
}
