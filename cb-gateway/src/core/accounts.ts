// 账号层：一个通道的一个实例（一套上游凭据）。**内存副本和库必须一起更新**——只更内存重启后
// 状态倒退，只更库本次进程读到旧状态（2026-11-23 在 45 上踩过）。状态机只在路由层改。

import {
  deleteAccount as deleteAccountRow,
  listAccounts as listAccountRows,
  readSeqCursor,
  upsertAccount,
  writeSeqCursor,
} from '../store/accounts.ts';
import type { Account, AccountProfile, AccountStatus } from '../types.ts';

export type { Account, AccountProfile, AccountStatus };

const cache = new Map<string, Account>();
let loaded = false;

/** 测试把 `QB_DATA_DIR` 指到临时目录后必须再调它，否则读到旧副本。 */
export function loadAccounts(): Account[] {
  cache.clear();
  for (const account of listAccountRows()) cache.set(account.id, account);
  loaded = true;
  return [...cache.values()];
}

function ensureLoaded(): Map<string, Account> {
  if (!loaded) loadAccounts();
  return cache;
}

function persist(account: Account): void {
  upsertAccount(account);
  cache.set(account.id, account);
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

/** 序号取游标和现存最大值里更大的 + 1，删过的号不回收。 */
export function addAccount(input: NewAccountInput): Account {
  ensureLoaded();
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
    statusMessage: null,
    profile: input.profile || {},
    checkinEnabled: true,
    createdAt: now,
    updatedAt: now,
  };
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

export function setAccountCheckinEnabled(id: string, enabled: boolean): Account | undefined {
  const account = getAccount(id);
  if (!account) return undefined;
  account.checkinEnabled = enabled;
  account.updatedAt = Date.now();
  persist(account);
  return account;
}

export function removeAccount(id: string): boolean {
  const account = getAccount(id);
  if (!account) return false;
  if (!deleteAccountRow(account.id)) return false;
  ensureLoaded().delete(account.id);
  return true;
}

export function setStatus(
  id: string,
  status: AccountStatus,
  options: { message?: string } = {},
): Account | undefined {
  const account = getAccount(id);
  if (!account) return undefined;
  account.status = status;
  account.statusMessage = options.message ?? null;
  account.updatedAt = Date.now();
  persist(account);
  return account;
}

export function markReady(id: string): Account | undefined {
  return setStatus(id, 'ready');
}

export function markInvalid(id: string, message?: string): Account | undefined {
  return setStatus(id, 'invalid', { message });
}

/**
 * 401 → `invalid`，其余不动（4xx/5xx 是这次请求不行，不该记到账号头上）。
 *
 * **429 不在这里处理**：上游限流是按模型的，恢复时间网关猜不准（WorkBuddy 连
 * `Retry-After` 都不发），所以路由层把 429 原样回给客户端、让客户端自己退避。
 * 这里曾经有 `429 → cooldown` 分支，但路由层的 `else if` 让它永远走不到，
 * 2026-11-27 连同 `cooldown` 状态一起删掉了。
 * **本地刷不出凭据也不走这里**——那连请求都没发出去。
 */
export function applyFailure(account: Account, status: number, message: string): Account | undefined {
  if (status === 401) return markInvalid(account.id, message);
  return undefined;
}

export type GateCode = 'account_invalid' | 'account_disabled';

export interface AccountGate {
  ok: boolean;
  code?: GateCode;
  message?: string;
}

/** 这个账号现在能不能发请求。不能时给出**人话**（带账号 id，用户得知道去改哪个）。 */
export function checkUsable(account: Account): AccountGate {
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
  return { ok: true };
}

const refreshInFlight = new Map<string, Promise<any>>();

const DEFAULT_SKEW_MS = 10 * 60 * 1000;

/** 各通道形状不一样：WorkBuddy / Trae 是数字，Qoder 存 ISO 串。 */
function expiryOf(credential: any): number {
  const raw = credential?.expiresAt;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw !== '') {
    const at = Date.parse(raw);
    return Number.isFinite(at) ? at : 0;
  }
  return 0;
}

/**
 * 快过期就用通道的 `refresh` 换新的并写回账号。
 *
 * **并发必须共享同一次刷新**：多个请求同时撞上过期时各换一次，上游会把前一次换出来的作废，
 * 于是前一个请求拿到的 token 立刻失效。
 */
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
      // 刷出来的 token 下个进程也要用，只在内存里留着等于每次重启白刷。
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
