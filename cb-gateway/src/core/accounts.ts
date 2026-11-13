import fs from 'node:fs';
import path from 'node:path';

import { ACCOUNTS_DIR } from '../shared/paths.ts';
import { writeFileAtomic } from '../shared/atomic-write.ts';
import { formatClock } from '../shared/clock.ts';
import type { Account, AccountProfile, AccountStatus } from '../types.ts';

export type { Account, AccountProfile, AccountStatus };

const STATUSES: AccountStatus[] = ['ready', 'cooldown', 'invalid', 'disabled'];

function channelDir(channelId: string): string {
  return path.join(ACCOUNTS_DIR, channelId);
}

function accountPath(channelId: string, accountId: string): string {
  return path.join(channelDir(channelId), `${accountId}.json`);
}

function seqPath(channelId: string): string {
  return path.join(channelDir(channelId), '.seq');
}

function readSeqCursor(channelId: string): number {
  try {
    const doc = JSON.parse(fs.readFileSync(seqPath(channelId), 'utf8'));
    const value = Number(doc?.seq);
    return Number.isInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function writeSeqCursor(channelId: string, seq: number): void {
  writeFileAtomic(seqPath(channelId), `${JSON.stringify({ seq }, null, 2)}\n`);
}

function normalizeStatus(raw: any): AccountStatus {
  return STATUSES.includes(raw) ? raw : 'invalid';
}

function readAccountFile(file: string): Account | null {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!doc || typeof doc.id !== 'string' || doc.id === '') return null;
    if (typeof doc.channelId !== 'string' || doc.channelId === '') return null;
    const seq = Number(doc.seq);
    if (!Number.isInteger(seq) || seq <= 0) return null;
    return {
      id: doc.id,
      channelId: doc.channelId,
      seq,
      label: typeof doc.label === 'string' && doc.label !== '' ? doc.label : doc.id,
      credential: doc.credential ?? null,
      status: normalizeStatus(doc.status),
      cooldownUntil: typeof doc.cooldownUntil === 'number' ? doc.cooldownUntil : null,
      statusMessage: typeof doc.statusMessage === 'string' ? doc.statusMessage : null,
      profile: doc.profile && typeof doc.profile === 'object' && !Array.isArray(doc.profile) ? doc.profile : {},
      createdAt: typeof doc.createdAt === 'number' ? doc.createdAt : 0,
      updatedAt: typeof doc.updatedAt === 'number' ? doc.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

const cache = new Map<string, Account>();
let loaded = false;

export function loadAccounts(): Account[] {
  cache.clear();
  let dirs: string[] = [];
  try {
    dirs = fs
      .readdirSync(ACCOUNTS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    dirs = [];
  }
  for (const channelId of dirs) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(path.join(ACCOUNTS_DIR, channelId));
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith('.json')) continue;
      const account = readAccountFile(path.join(ACCOUNTS_DIR, channelId, name));
      if (account) cache.set(account.id, account);
    }
  }
  loaded = true;
  return [...cache.values()];
}

function ensureLoaded(): Map<string, Account> {
  if (!loaded) loadAccounts();
  return cache;
}

function persist(account: Account): void {
  const dir = channelDir(account.channelId);
  fs.mkdirSync(dir, { recursive: true });
  const body = {
    id: account.id,
    channelId: account.channelId,
    seq: account.seq,
    label: account.label,
    credential: account.credential,
    status: account.status,
    cooldownUntil: account.cooldownUntil,
    statusMessage: account.statusMessage,
    profile: account.profile,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
  const file = accountPath(account.channelId, account.id);
  writeFileAtomic(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
  }
}

export function accountsOf(channelId: string): Account[] {
  return [...ensureLoaded().values()].filter((item) => item.channelId === channelId).sort((a, b) => a.seq - b.seq);
}

export function listAccounts(channelIds: readonly string[]): Account[] {
  const out: Account[] = [];
  for (const channelId of channelIds) out.push(...accountsOf(channelId));
  return out;
}

export function getAccount(id: string): Account | undefined {
  return ensureLoaded().get(id);
}

export function findAccountByUid(channelId: string, uid: string): Account | undefined {
  if (!uid) return undefined;
  return accountsOf(channelId).find((account) => account.profile?.uid === uid);
}

export interface NewAccountInput {
  channelId: string;
  idPrefix: string;
  credential: any;
  label?: string;
  profile?: AccountProfile;
}

export function addAccount(input: NewAccountInput): Account {
  const map = ensureLoaded();
  const existing = accountsOf(input.channelId);
  const highest = existing.reduce((max, item) => Math.max(max, item.seq), 0);
  const seq = Math.max(readSeqCursor(input.channelId), highest) + 1;
  writeSeqCursor(input.channelId, seq);

  const now = Date.now();
  const account: Account = {
    id: `${input.idPrefix}-${seq}`,
    channelId: input.channelId,
    seq,
    label: input.label || `账号${seq}`,
    credential: input.credential,
    status: 'ready',
    cooldownUntil: null,
    statusMessage: null,
    profile: input.profile || {},
    createdAt: now,
    updatedAt: now,
  };
  map.set(account.id, account);
  persist(account);
  return account;
}

export interface AccountPatch {
  label?: string;
  credential?: any;
  profile?: AccountProfile;
}

export function updateAccount(id: string, patch: AccountPatch): Account | undefined {
  const account = getAccount(id);
  if (!account) return undefined;
  if (typeof patch.label === 'string' && patch.label !== '') account.label = patch.label;
  if (patch.credential !== undefined) account.credential = patch.credential;
  if (patch.profile !== undefined) account.profile = patch.profile;
  account.updatedAt = Date.now();
  persist(account);
  return account;
}

export function removeAccount(id: string): boolean {
  const account = getAccount(id);
  if (!account) return false;
  try {
    fs.rmSync(accountPath(account.channelId, account.id), { force: true });
  } catch {
    return false;
  }
  ensureLoaded().delete(account.id);
  return true;
}

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

export function setStatus(
  id: string,
  status: AccountStatus,
  options: { until?: number; message?: string } = {},
): Account | undefined {
  const account = getAccount(id);
  if (!account) return undefined;
  account.status = status;
  account.cooldownUntil = status === 'cooldown' ? (options.until ?? Date.now() + DEFAULT_COOLDOWN_MS) : null;
  account.statusMessage = options.message ?? null;
  account.updatedAt = Date.now();
  persist(account);
  return account;
}

export function markReady(id: string): Account | undefined {
  return setStatus(id, 'ready');
}

export function markCooldown(id: string, until?: number, message?: string): Account | undefined {
  return setStatus(id, 'cooldown', { until, message });
}

export function markInvalid(id: string, message?: string): Account | undefined {
  return setStatus(id, 'invalid', { message });
}

export function applyFailure(
  account: Account,
  status: number,
  message: string,
  retryAt: number | null = null,
): Account | undefined {
  if (status === 401) return markInvalid(account.id, message);
  if (status === 429) return markCooldown(account.id, retryAt ?? undefined, message);
  return undefined;
}

export type GateCode = 'account_cooldown' | 'account_invalid' | 'account_disabled';

export interface AccountGate {
  ok: boolean;
  code?: GateCode;
  message?: string;
}

export function checkUsable(account: Account, now = Date.now()): AccountGate {
  if (account.status === 'disabled') {
    return {
      ok: false,
      code: 'account_disabled',
      message: `账号 ${account.id} 已停用，去管理台启用后再用`,
    };
  }
  if (account.status === 'invalid') {
    return {
      ok: false,
      code: 'account_invalid',
      message: `账号 ${account.id} 的凭据已失效，去管理台重新登录${account.statusMessage ? `（${account.statusMessage}）` : ''}`,
    };
  }
  if (account.status === 'cooldown') {
    if (account.cooldownUntil && account.cooldownUntil > now) {
      return {
        ok: false,
        code: 'account_cooldown',
        message: `账号 ${account.id} 限流中，${formatClock(account.cooldownUntil)} 后可再用${account.statusMessage ? `（${account.statusMessage}）` : ''}`,
      };
    }
    markReady(account.id);
  }
  return { ok: true };
}

const refreshInFlight = new Map<string, Promise<any>>();

const DEFAULT_SKEW_MS = 10 * 60 * 1000;

function expiryOf(credential: any): number {
  const raw = credential?.expiresAt;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw !== '') {
    const at = Date.parse(raw);
    return Number.isFinite(at) ? at : 0;
  }
  return 0;
}

export async function usableCredential(
  account: Account,
  refresh: (credential: any) => Promise<any>,
  options: { forceRefresh?: boolean; skewMs?: number } = {},
): Promise<any> {
  const credential = account.credential;
  if (!credential) throw new Error(`账号 ${account.id} 没有凭据，请重新登录`);

  const expiresAt = expiryOf(credential);
  const skew = options.skewMs ?? DEFAULT_SKEW_MS;
  if (!options.forceRefresh && (!expiresAt || expiresAt - Date.now() > skew)) return credential;

  const running = refreshInFlight.get(account.id);
  if (running) return running;

  const task = (async () => {
    try {
      const next = await refresh(credential);
      updateAccount(account.id, { credential: next });
      account.credential = next;
      return next;
    } finally {
      refreshInFlight.delete(account.id);
    }
  })();
  refreshInFlight.set(account.id, task);
  return task;
}
