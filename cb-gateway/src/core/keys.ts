// API key：给程序用的访问票据。
//
// 和网页密码分开：密码给「人能进管理台」，key 给「程序能调 API」。改密码不该让 DSH
// 掉线，吊销一把 key 也不该让浏览器退出登录。
//
// **明文不落库**：库里只有 `salt` + `hash`（scrypt，不可逆）和 `prefix`（明文前 12
// 字符，只为列表上分清哪把是哪把）。明文只在 `POST /api/keys` 的响应里出现一次。
//
// **校验走内存快照 + scrypt 兜底**：scrypt 单次实测 61ms，而查库只要 0.03ms，所以维护
// `Map<sha256(secret), record>`——命中直接放行，跳过 scrypt。键用 sha256 而不是明文，
// 否则「删了库里的明文却在内存里又存回来」。
//
// **不能预热**：sha256(secret) 需要 secret 本身，而库里只有不可逆的 scrypt 结果，
// 所以每个 key 进程内第一次请求必然付一次 scrypt。
//
// 快照失效三条路：本进程改 key（立即清空）、TTL 到期（给「进程外改库」兜底，默认
// 1 天、页面可改）、进程重启（天然是空的）。

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

/**
 * 票据前缀。**故意和 OpenAI 的 key 同形**：`sk-` + 48 位字母数字。
 *
 * 这样配 DSH、curl、别的 OpenAI 客户端时不用解释「我们这个是 qb- 开头」，
 * 顺带让 key 混在日志/配置里也不显得突兀。
 */
const PREFIX = 'sk-';
/** 主体长度。OpenAI 那套是 48 位，总长 51。 */
const SECRET_BODY_LEN = 48;
/**
 * 主体字符集：大小写字母 + 数字（62 个）。
 *
 * 不用 base64url：那会带 `-` 和 `_`，和 OpenAI 的形制不一样，而且一眼看不出边界。
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** 给页面展示的明文长度：`sk-` + 9 字符。 */
const VISIBLE_PREFIX_LEN = 12;
const SALT_BYTES = 16;
/** scrypt 代价参数。本机单用户工具，够用且不像 bcrypt 那样要额外依赖。 */
const SCRYPT = { N: 16384, r: 8, p: 1 };
const SECRET_BYTES_OUT = 32;
/** `lastUsedAt` 最多每分钟写一次库：它是给人看的，不值得每个请求都写一次。 */
const TOUCH_INTERVAL_MS = 60 * 1000;

/** 快照 TTL 的默认值。1 天——手动改库的概率太小，不值得频繁查库。 */
const DEFAULT_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
/** 允许的下限：再短就是在拿 scrypt 换"更及时"，没有意义。 */
const MIN_SNAPSHOT_TTL_MS = 60 * 1000;

/**
 * 给页面/API 的视图。
 *
 * **没有 `secret` 字段**。明文只在创建那一次的响应顶层出现。
 */
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

/**
 * 内存快照：`sha256(secret)` → 记录。
 *
 * 只装**启用的** key。停用/删除后靠失效清掉。
 */
let snapshot: Map<string, ApiKeyRecord> | null = null;
/** 快照建立时刻，用于 TTL 判断。`null` 表示还没有快照。 */
let snapshotAt = 0;
/** TTL 可配置（设置页改）。改完立即清空快照，新的值马上生效。 */
let snapshotTtlMs = DEFAULT_SNAPSHOT_TTL_MS;

/** `lastUsedAt` 的写库节流表。 */
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
 * 生成 key 的主体（不含 `sk-`）。
 *
 * **拒绝采样**：62 不整除 256，直接 `byte % 62` 会让前 8 个字符出现得更频繁
 * （248..255 落在 0..7）。丢掉 >= 248 的字节，每位就是均匀的。
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

// ---------------------------------------------------------------- 快照

/** 清空快照。改 key、或设置变化时调。 */
export function invalidateKeySnapshot(): void {
  snapshot = null;
  snapshotAt = 0;
}

/** 快照是否还能用。 */
function snapshotValid(): boolean {
  if (snapshot === null) return false;
  return Date.now() - snapshotAt < snapshotTtlMs;
}

/**
 * 取（必要时建）快照。
 *
 * **空快照也要建**：没有可用 key 时，每次请求都查库没有意义。
 * 用 `snapshot !== null` 判断「建过」，不是用 `size > 0`。
 */
function getSnapshot(): Map<string, ApiKeyRecord> {
  if (snapshotValid()) return snapshot as Map<string, ApiKeyRecord>;

  const map = new Map<string, ApiKeyRecord>();
  // 注意：这里**装不进任何东西**——因为键是 sha256(secret)，而库里没有 secret。
  // 快照只能靠 `verifyKey` 校验成功后逐条填充。这次「重建」只是把过期数据丢掉。
  snapshot = map;
  snapshotAt = Date.now();
  return map;
}

/** 设置快照 TTL。传 `null` 恢复默认；非法值忽略。 */
export function setKeySnapshotTtl(ttlMs: number | null): number {
  if (ttlMs === null) {
    snapshotTtlMs = DEFAULT_SNAPSHOT_TTL_MS;
  } else if (Number.isFinite(ttlMs) && ttlMs >= MIN_SNAPSHOT_TTL_MS) {
    snapshotTtlMs = Math.floor(ttlMs);
  }
  // 改了立刻生效：旧快照按老 TTL 算的，留着会让"改完没反应"。
  invalidateKeySnapshot();
  return snapshotTtlMs;
}

/** 当前 TTL（毫秒）。设置页展示用。 */
export function keySnapshotTtl(): number {
  return snapshotTtlMs;
}

// ---------------------------------------------------------------- 对外

/** 全部 key（不含任何敏感字段），按创建时间升序。 */
export function listKeys(): ApiKeyPublic[] {
  return listKeyRecords().map(publicOf);
}

/** 有没有任何能用的 key。没有的话启动日志要提醒一句「去 /keys 建一把」。 */
export function hasAnyCredential(): boolean {
  return hasEnabledKey();
}

/**
 * 新建一把 key。
 *
 * 明文**只在这里产出一次**：写进响应给它，库里只留 scrypt 材料。
 * 调用方没记下来就得重建。
 */
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

/** 改标签 / 停用。停用立刻生效（下一次请求就是 401），不删记录（留审计）。 */
export function updateKey(id: string, patch: { label?: string; enabled?: boolean }): ApiKeyPublic | undefined {
  const normalized: { label?: string; enabled?: boolean } = {};
  if (typeof patch.label === 'string' && patch.label.trim() !== '') normalized.label = patch.label.trim().slice(0, 60);
  if (typeof patch.enabled === 'boolean') normalized.enabled = patch.enabled;
  const updated = updateKeyRow(id, normalized);
  // 状态变了就得让快照失效，否则停用之后还能用到 TTL 到期。
  invalidateKeySnapshot();
  return updated ? publicOf(updated) : undefined;
}

/** 删除一把 key（连哈希一起删）。 */
export function deleteKey(id: string): boolean {
  const removed = deleteKeyRow(id);
  // 删了也要清：快照里存着那条记录本身，不清就还能通过校验。
  invalidateKeySnapshot();
  return removed;
}

/**
 * 校验一个 secret。
 *
 * 两步：
 *   1. 快照命中 → 直接放行（微秒级，不碰 scrypt、不碰库）
 *   2. 未命中 → 按前缀查库 → scrypt 比对 → 成功则写入快照
 *
 * 常量时间比对：`crypto.timingSafeEqual`，长度不同时直接返回 false
 * （长度泄露不算问题——长度是固定的 51 字符）。
 */
export function verifyKey(secret: string): ApiKeyRecord | null {
  if (typeof secret !== 'string' || !secret.startsWith(PREFIX)) return null;

  const key = digest(secret);
  const cached = getSnapshot().get(key);
  if (cached) {
    touch(cached.id);
    return cached;
  }

  // 快照未命中：前缀把候选压到通常 1 条
  const candidates = findEnabledKeysByPrefix(secret.slice(0, VISIBLE_PREFIX_LEN));
  if (candidates.length === 0) return null;

  for (const record of candidates) {
    if (record.salt === '' || record.hash === '') continue; // 残缺记录，跳过
    // 比对的是 scrypt 结果而不是明文——库里没有明文，这是唯一的校验材料。
    // 两边长度固定（32 字节），所以长度检查只是为了防御坏数据。
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

/** 记一次「最后使用时间」，写库按分钟节流。 */
function touch(id: string): void {
  const now = Date.now();
  const previous = lastTouched.get(id) || 0;
  if (now - previous < TOUCH_INTERVAL_MS) return;
  lastTouched.set(id, now);
  touchKey(id, now);
}

/** 测试用：丢掉内存状态。 */
export function resetKeysForTests(): void {
  snapshot = null;
  snapshotAt = 0;
  snapshotTtlMs = DEFAULT_SNAPSHOT_TTL_MS;
  lastTouched.clear();
}
