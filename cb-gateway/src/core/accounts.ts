// 账号层：一个通道的一个实例（一套上游凭据）。
//
// v1 是「一个通道一份凭据」——凭据落在 `data/auth/workbuddy.json`，由通道自己的
// auth 模块以模块级单例缓存着。那样一个通道只能挂一个号。v2 一个通道挂 N 个，
// 每个号有自己的额度、登录态和状态，所以凭据必须从「模块单例」变成「传进来的对象」。
//
// **这里没有调度器、没有轮询计数**，只有「读一个账号、判状态、更新状态」。选哪个号
// 是请求里的模型 id 决定的（`wb-1/hy4free` 就是 1 号），网关不替用户挑号——偷偷换到
// 别的号会让账对不上（用户以为花的是 A 的额度，实际花了 B 的）。
//
// 状态机（v2 里唯一会被账号维度改动的东西）：
//
//   ready ──上游 429──▶ cooldown（带截止时间，到点自动回 ready）
//   ready ──上游 401──▶ invalid（凭据坏了，只能重新登录）
//   disabled            用户主动停用，和 invalid 分开：都不影响 id 存在，但文案不同
//
// 状态**只在路由层改**（`routes/openai.ts` 捕获上游错误后调 `mark*`），通道本身不写
// 状态——通道只管协议翻译，它连「我还有几个兄弟账号」都不知道。

import { formatClock } from '../shared/clock.ts';
import {
  deleteAccount as deleteAccountRow,
  listAccounts as listAccountRows,
  readSeqCursor,
  upsertAccount,
  writeSeqCursor,
} from '../store/accounts.ts';
import type { Account, AccountProfile, AccountStatus } from '../types.ts';

// 类型定义在 `../types.ts`（跨边界流动的数据都放那儿）；这里重导出，好让
// 「读账号」的模块只 import 一个地方。
export type { Account, AccountProfile, AccountStatus };

// ---------------------------------------------------------------- 存储
//
// v4 起账号在 `account` / `account_seq` 两张表里（`store/accounts.ts` 管 SQL），
// 这里只剩**内存副本 + 策略**。
//
// **内存副本保留**（private/docs/v4 §5.4）：账号是热数据，每个请求都要按 id 查；而写操作
// 少（登录、改状态、刷凭据）。前提是 `persist()` 必须同时更新内存和库——只更内存
// 会让重启后状态倒退，只更库会让本次进程读到旧状态。

const cache = new Map<string, Account>();
let loaded = false;

/**
 * 从库里（重新）加载全部账号进内存副本。
 *
 * 启动时调一次。测试把 `QB_DATA_DIR` 指到临时目录之后也要调它，否则读到的是
 * 上一次加载留下的内存副本。
 */
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

/** 写回一行。**内存和库一起更新**——只更一边会让本条或下一条请求读到旧值。 */
function persist(account: Account): void {
  upsertAccount(account);
  cache.set(account.id, account);
}

// ---------------------------------------------------------------- 查询

/** 某个通道的账号，按序号升序。 */
export function accountsOf(channelId: string): Account[] {
  return [...ensureLoaded().values()].filter((item) => item.channelId === channelId).sort((a, b) => a.seq - b.seq);
}

/** 全部账号，按通道顺序（`channelIds` 传进来的次序）再按序号。 */
export function listAccounts(channelIds: readonly string[]): Account[] {
  const out: Account[] = [];
  for (const channelId of channelIds) out.push(...accountsOf(channelId));
  return out;
}

export function getAccount(id: string): Account | undefined {
  return ensureLoaded().get(id);
}

/** 按上游 uid 找同通道里已有的账号，给「同一个号登两次」去重用。 */
export function findAccountByUid(channelId: string, uid: string): Account | undefined {
  if (!uid) return undefined;
  return accountsOf(channelId).find((account) => account.profile?.uid === uid);
}

// ---------------------------------------------------------------- 增删改

export interface NewAccountInput {
  channelId: string;
  /** 通道的短前缀，id 的前半段（`wb` → `wb-1`）。 */
  idPrefix: string;
  credential: any;
  label?: string;
  profile?: AccountProfile;
}

/** 加一个账号。序号取游标和现存最大值里更大的那个 + 1，删过的号不回收。 */
export function addAccount(input: NewAccountInput): Account {
  ensureLoaded();
  const existing = accountsOf(input.channelId);
  const highest = existing.reduce((max, item) => Math.max(max, item.seq), 0);
  // 游标只增不减：`writeSeqCursor` 里还会再夹一次 `max(当前游标, 传入值)`。
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
    // 新号默认参与签到：多数人加号就是为了让它签，默认关掉等于要求逐个手动打开。
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

/** 改 label / 凭据 / 上游账号信息。状态不走这里（见 `setStatus`）。 */
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

/** 改这个号的自动签到开关。走 `persist()` 才会同时更新内存副本和库。 */
export function setAccountCheckinEnabled(id: string, enabled: boolean): Account | undefined {
  const account = getAccount(id);
  if (!account) return undefined;
  account.checkinEnabled = enabled;
  account.updatedAt = Date.now();
  persist(account);
  return account;
}

/**
 * 删账号（连凭据一起）。返回是否真的删了。
 *
 * 签到状态由外键级联删除（`checkin_state` 上的 `ON DELETE CASCADE`），所以这里
 * 不用再记得清什么——文件时代漏过（`tr-1` / `tr-2` 的账号删了、状态文件还在）。
 */
export function removeAccount(id: string): boolean {
  const account = getAccount(id);
  if (!account) return false;
  if (!deleteAccountRow(account.id)) return false;
  ensureLoaded().delete(account.id);
  return true;
}

// ---------------------------------------------------------------- 状态机

/** 上游 429 没给「什么时候恢复」时的兜底冷却时长。 */
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

/**
 * 按上游报的状态码改账号状态。**这是整条链路上唯一改状态的地方**（路由层调它）。
 *
 *   401 → `invalid`（凭据坏了，刷新也救不回来）
 *   429 → `cooldown`（带 `Retry-After` 的截止时间，没有就兜底 5 分钟）
 *   其余 → 不动（4xx/5xx 是上游在说这次请求不行，不该记到账号头上）
 *
 * **凭据类错误不走这里**：它们由 `shared/credential-error.ts` 表达，路由层查
 * `permanent` 再调 `markInvalid()`。原因是「上游回 401」和「本地根本刷不出凭据」
 * 是两件事：前者上游还在，后者连请求都没发出去，而两者的处置一样（重新登录）。
 */
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

/**
 * 这个账号现在能不能发请求。不能时给出**人话**（要带账号 id，用户得知道去改哪个）。
 *
 * `cooldown` 到点会自动翻回 `ready`（并落盘）：一次限流不该永久锁死账号，
 * 而重启网关时也没人有空去手动清状态。
 */
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

// ---------------------------------------------------------------- 凭据刷新

const refreshInFlight = new Map<string, Promise<any>>();

/** 距过期还有这么久就提前刷新，别让请求正好撞在过期点上。 */
const DEFAULT_SKEW_MS = 10 * 60 * 1000;

/**
 * 凭据的过期时间（毫秒时间戳），读不出来返回 0。
 *
 * 各通道存的形状不一样：WorkBuddy / Trae 是数字，Qoder 存的是 ISO 字符串
 * （客户端原样存的就是那个格式）。这里一并认，省得每个通道各写一遍判断。
 */
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
 * 取一份**可用**凭据：快过期就用通道自己的 `refresh` 换新的，并把新凭据写回账号。
 *
 * 约定：凭据对象上如果带 `expiresAt`（毫秒时间戳或 ISO 串）就由这里判过期；
 * 没有这个字段的通道（凭据不过期，或者通道自己管）原样返回。
 *
 * 并发共享同一次刷新——多个请求同时撞上过期时，不该各换一次 token（上游往往会把
 * 前一次换出来的作废，于是前一个请求拿到的 token 立刻失效）。
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
      // 写回账号文件：刷新出来的 token 是下一个进程也要用的，只在内存里留着
      // 等于每次重启都白刷一次。
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
