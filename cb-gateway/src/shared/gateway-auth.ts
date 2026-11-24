// 网关自己的**网页**登录态：账号密码 + 会话 Cookie。
//
// 调用网关的有两类客户端，凭据完全不同，别混：
//
//   1. 浏览器（网关页面）→ 账号密码换会话 Cookie（这个文件）
//   2. 程序（DSH 宿主进程、脚本）→ `Authorization: Bearer sk-…`（`core/keys.ts`）
//
// 密码用 scrypt 存，绝不明文。**改密码不影响任何 API key**：两者是独立凭据，
// 改密码不该让 DSH 掉线，吊销一把 key 也不该让浏览器退出登录。
//
// v1 曾在这个文件里存一段明文 `token` 当机器凭据。v2 起彻底不认它——机器凭据只有
// `api_key` 表一处。v4 起这份凭据也进库（`gateway_credential` 单行表），
// **不在 JSON 文件里了**：`store/credentials.ts` 负责存取，本文件只留策略。

import crypto from 'node:crypto';

import { getCredential, putCredential } from '../store/credentials.ts';

/** 默认账号。只用于**首次启动**，且强制要求立刻改密码。 */
const DEFAULT_USERNAME = 'admin';
const DEFAULT_PASSWORD = 'admin';

/** 会话有效期。够一天，过期就得重新登录。 */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

interface GatewayCredential {
  username: string;
  /** scrypt 的盐，hex。 */
  salt: string;
  /** scrypt(password, salt, 64) 的 hex。 */
  hash: string;
  /** 首次登录后必须先改密码，否则除登录/改密外的路由一律拒绝。 */
  mustChangePassword: boolean;
}

interface Session {
  username: string;
  expiresAt: number;
}

const sessions = new Map<string, Session>();

let cached: GatewayCredential | null = null;

function hashPassword(password: string, salt: string) {
  // 64 字节输出、默认代价参数。对本机单用户工具足够，且不像 bcrypt 那样要依赖。
  return crypto.scryptSync(password, Buffer.from(salt, 'hex'), 64).toString('hex');
}

function timingSafeEqualHex(a: string, b: string) {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

function writeCredential(credential: GatewayCredential) {
  // 写库是事务性的，不再需要原子写那套 tmp+rename：半截文件会让 `loadCredential()`
  // 当「文件坏了」于是**重建默认账号 admin/admin**——网关密码被静默重置成默认值。
  // 这是 v4 把凭据从文件搬进库的收益之一。
  putCredential(credential);
  cached = credential;
}

/** 首次启动时创建默认账号。**不生成 token**——机器凭据是 API key，在 `/keys` 页发。 */
function createDefault() {
  const salt = crypto.randomBytes(16).toString('hex');
  const credential: GatewayCredential = {
    username: DEFAULT_USERNAME,
    salt,
    hash: hashPassword(DEFAULT_PASSWORD, salt),
    mustChangePassword: true,
  };
  writeCredential(credential);
  return credential;
}

/**
 * 读取凭据；库里没有就建默认的。
 *
 * **只取这四个字段**：v1 的 `gateway.json` 里多一个明文 `token`，那个字段在导入时
 * 就已经被丢掉了（`gateway_credential` 表没有它），不会再被写回来。
 */
export function loadCredential(): GatewayCredential {
  if (cached) return cached;
  const stored = getCredential();
  if (stored) {
    cached = stored;
    return cached;
  }
  return createDefault();
}

export function mustChangePassword() {
  return loadCredential().mustChangePassword;
}

export function username() {
  return loadCredential().username;
}

/** 用户名 + 密码校验。任何一项不匹配都返回 false，不区分原因（避免探测用户名）。 */
export function verifyPassword(user: string, password: string) {
  const credential = loadCredential();
  if (user !== credential.username) {
    // 即使用户名不对也走一次哈希，避免通过响应时间判断用户名是否存在。
    hashPassword(password, credential.salt);
    return false;
  }
  return timingSafeEqualHex(hashPassword(password, credential.salt), credential.hash);
}

/**
 * 改密码。必须先验证旧密码。
 *
 * @returns 失败时返回人话原因；成功返回 null。
 */
export function changePassword(currentPassword: string, nextPassword: string): string | null {
  const credential = loadCredential();
  if (!verifyPassword(credential.username, currentPassword)) return '当前密码不对';
  if (typeof nextPassword !== 'string' || nextPassword.length < 6) return '新密码至少 6 位';
  if (nextPassword === currentPassword) return '新密码不能和当前密码相同';

  const salt = crypto.randomBytes(16).toString('hex');
  writeCredential({
    ...credential,
    salt,
    hash: hashPassword(nextPassword, salt),
    mustChangePassword: false,
  });
  return null;
}

/**
 * 从 Authorization 头里取 Bearer 的值。取不到返回 null。
 *
 * **只解析，不判断**：认不认这个凭据由 authGate 决定（它拿去问 core/keys.ts）。
 * 解析和判断分开，加一种凭据类型时不用动这个函数。
 */
export function extractBearer(header: any): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)\s*$/iu.exec(header);
  return match ? match[1] : null;
}
export function createSession() {
  const sid = crypto.randomBytes(32).toString('hex');
  sessions.set(sid, { username: loadCredential().username, expiresAt: Date.now() + SESSION_TTL_MS });
  return sid;
}

export function sessionValid(sid: any) {
  if (typeof sid !== 'string' || sid === '') return false;
  const session = sessions.get(sid);
  if (!session) return false;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(sid);
    return false;
  }
  return true;
}

export function destroySession(sid: any) {
  if (typeof sid === 'string') sessions.delete(sid);
}

/** 从 Cookie 头里取会话 id。只认 `gw_session`。 */
export function sessionFromCookie(cookieHeader: any) {
  if (typeof cookieHeader !== 'string') return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'gw_session') return rest.join('=') || null;
  }
  return null;
}

export function sessionCookie(sid: string) {
  // HttpOnly：脚本读不到，减少 XSS 面；SameSite=Lax：跨站 POST 不带 Cookie。
  // 网关可能跑在 http（内网），所以不设 Secure。
  return `gw_session=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

export function clearCookie() {
  return 'gw_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

/** 测试用：把内存态清掉，让下一次调用重新读盘。 */
export function resetForTests() {
  cached = null;
  sessions.clear();
}
