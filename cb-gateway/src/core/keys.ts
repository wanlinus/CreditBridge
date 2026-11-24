// API key：给程序用的访问票据。和网页密码互相独立——改密码不该让 DSH 掉线，吊销一把 key
// 也不该让浏览器退出登录。
//
// **明文不落库**：库里只有 `salt` + `hash`（scrypt，不可逆）和 `prefix`，明文只在
// `POST /api/keys` 的响应里出现一次。
//
// 校验走内存快照 + scrypt 兜底（单次 61ms vs 查库 0.03ms）。**不能预热**——sha256 需要 secret
// 本身，而库里只有不可逆的 scrypt 结果，所以每把 key 第一次请求必然付一次 scrypt。

import crypto from 'node:crypto';

import {
  deleteKeyRow,
  findEnabledKeysByPrefix,
  hasEnabledKey,
  insertKey,
  listKeys as listKeyRecords,
  touchKey,
  updateKeyRow,
  type ApiKeyRecord,
} from '../store/keys.ts';

/** **故意和 OpenAI 的 key 同形**：`sk-` + 48 位字母数字，配 DSH 不用解释。 */
const PREFIX = 'sk-';
const SECRET_BODY_LEN = 48;
/** 不用 base64url：那会带 `-` 和 `_`，形制就和 OpenAI 不一样了。 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** 页面展示用的明文长度。 */
const VISIBLE_PREFIX_LEN = 12;
const SALT_BYTES = 16;
const SCRYPT = { N: 16384, r: 8, p: 1 };
const SECRET_BYTES_OUT = 32;
/** `lastUsedAt` 最多每分钟写一次库：它是给人看的，不值得每个请求都写一次。 */
const TOUCH_INTERVAL_MS = 60 * 1000;

/** 1 天——手动改库的概率太小。 */
const DEFAULT_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
/** 再短就是在拿 scrypt 换「更及时」。 */
const MIN_SNAPSHOT_TTL_MS = 60 * 1000;

/** **没有 `secret` 字段**。 */
export interface ApiKeyPublic {
  id: string;
  label: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  enabled: boolean;
  accountScope: string[] | null;
}

export type { ApiKeyRecord };

/** 内存快照：`sha256(secret)` → 记录。只装**启用的** key。 */
let snapshot: Map<string, ApiKeyRecord> | null = null;
let snapshotAt = 0;
let snapshotTtlMs = DEFAULT_SNAPSHOT_TTL_MS;

const lastTouched = new Map<string, number>();

function publicOf(record: ApiKeyRecord): ApiKeyPublic {
  return {
    id: record.id,
    label: record.label,
    prefix: record.prefix,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    enabled: record.enabled,
    accountScope: record.accountScope,
  };
}

function digest(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

/**
 * **拒绝采样**：62 不整除 256，直接 `byte % 62` 会让前 8 个字符出现得更频繁（248..255 落在
 * 0..7）。丢掉 >= 248 的字节，每位就是均匀的。
 */
function randomBody(length: number): string {
  const out: string[] = [];
  while (out.length < length) {
    for (const byte of crypto.randomBytes(length)) {
      if (byte >= 248) continue;
      out.push(ALPHABET[byte % 62]);
      if (out.length === length) break;
    }
  }
  return out.join('');
}

function hashSecret(secret: string, saltHex: string): Buffer {
  return crypto.scryptSync(secret, Buffer.from(saltHex, 'hex'), SECRET_BYTES_OUT, SCRYPT);
}

export function invalidateKeySnapshot(): void {
  snapshot = null;
  snapshotAt = 0;
}

function snapshotValid(): boolean {
  if (snapshot === null) return false;
  return Date.now() - snapshotAt < snapshotTtlMs;
}

/** **空快照也要建**：没有可用 key 时，每次请求都查库没有意义。用 `snapshot !== null` 判断「建过」。 */
function getSnapshot(): Map<string, ApiKeyRecord> {
  if (snapshotValid()) return snapshot as Map<string, ApiKeyRecord>;

  const map = new Map<string, ApiKeyRecord>();
  // 这里**装不进任何东西**——键是 sha256(secret)，而库里没有 secret。快照只能靠
  // `verifyKey` 校验成功后逐条填充；这次「重建」只是把过期数据丢掉。
  snapshot = map;
  snapshotAt = Date.now();
  return map;
}

/** 传 `null` 恢复默认；非法值忽略。 */
export function setKeySnapshotTtl(ttlMs: number | null): number {
  if (ttlMs === null) {
    snapshotTtlMs = DEFAULT_SNAPSHOT_TTL_MS;
  } else if (Number.isFinite(ttlMs) && ttlMs >= MIN_SNAPSHOT_TTL_MS) {
    snapshotTtlMs = Math.floor(ttlMs);
  }
  // 改了立刻生效：旧快照按老 TTL 算的，留着会让「改完没反应」。
  invalidateKeySnapshot();
  return snapshotTtlMs;
}

export function keySnapshotTtl(): number {
  return snapshotTtlMs;
}

export function listKeys(): ApiKeyPublic[] {
  return listKeyRecords().map(publicOf);
}

/** 有没有任何能用的 key，启动日志据此提醒去建一把。 */
export function hasAnyCredential(): boolean {
  return hasEnabledKey();
}

/** 明文**只在这里产出一次**，调用方没记下来就得重建。 */
export function createKey(label: string): { record: ApiKeyPublic; secret: string } {
  const secret = PREFIX + randomBody(SECRET_BODY_LEN);
  const salt = crypto.randomBytes(SALT_BYTES).toString('hex');
  const record: ApiKeyRecord = {
    id: `k_${crypto.randomBytes(4).toString('hex')}`,
    label: label.trim() === '' ? '未命名' : label.trim().slice(0, 60),
    salt,
    hash: hashSecret(secret, salt).toString('hex'),
    prefix: secret.slice(0, VISIBLE_PREFIX_LEN),
    createdAt: Date.now(),
    lastUsedAt: null,
    enabled: true,
    accountScope: null,
  };
  insertKey(record);
  // 刚建的 key 直接进快照——省掉它的第一次 scrypt。
  try {
    getSnapshot().set(digest(secret), record);
  } catch {
    /* 快照是优化，写不进去不影响正确性 */
  }
  return { record: publicOf(record), secret };
}

/** 停用立刻生效（下一次请求就是 401），不删记录（留审计）。 */
export function updateKey(id: string, patch: { label?: string; enabled?: boolean }): ApiKeyPublic | undefined {
  const normalized: { label?: string; enabled?: boolean } = {};
  if (typeof patch.label === 'string' && patch.label.trim() !== '') normalized.label = patch.label.trim().slice(0, 60);
  if (typeof patch.enabled === 'boolean') normalized.enabled = patch.enabled;
  const updated = updateKeyRow(id, normalized);
  // 状态变了就得让快照失效，否则停用之后还能用到 TTL 到期。
  invalidateKeySnapshot();
  return updated ? publicOf(updated) : undefined;
}

export function deleteKey(id: string): boolean {
  const removed = deleteKeyRow(id);
  // 删了也要清：快照里存着那条记录本身，不清就还能通过校验。
  invalidateKeySnapshot();
  return removed;
}

/** 快照命中直接放行（微秒级）；未命中则按前缀查库 → scrypt 比对 → 写入快照。 */
export function verifyKey(secret: string): ApiKeyRecord | null {
  if (typeof secret !== 'string' || !secret.startsWith(PREFIX)) return null;

  const key = digest(secret);
  const cached = getSnapshot().get(key);
  if (cached) {
    touch(cached.id);
    return cached;
  }

  // 前缀把候选压到通常 1 条
  const candidates = findEnabledKeysByPrefix(secret.slice(0, VISIBLE_PREFIX_LEN));
  if (candidates.length === 0) return null;

  for (const record of candidates) {
    if (record.salt === '' || record.hash === '') continue; // 残缺记录，跳过
    // 库里没有明文，scrypt 结果是唯一的校验材料。
    const expected = Buffer.from(record.hash, 'hex');
    const actual = hashSecret(secret, record.salt);
    const matched = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    if (matched) {
      getSnapshot().set(key, record);
      touch(record.id);
      return record;
    }
  }
  return null;
}

/** 写库按分钟节流。 */
function touch(id: string): void {
  const now = Date.now();
  const previous = lastTouched.get(id) || 0;
  if (now - previous < TOUCH_INTERVAL_MS) return;
  lastTouched.set(id, now);
  touchKey(id, now);
}

export function resetKeysForTests(): void {
  snapshot = null;
  snapshotAt = 0;
  snapshotTtlMs = DEFAULT_SNAPSHOT_TTL_MS;
  lastTouched.clear();
}
