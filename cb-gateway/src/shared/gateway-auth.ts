import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AUTH_DIR } from './paths.ts';
import { writeFileAtomic } from './atomic-write.ts';

export const CREDENTIAL_PATH = path.join(AUTH_DIR, 'gateway.json');

const DEFAULT_USERNAME = 'admin';
const DEFAULT_PASSWORD = 'admin';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

interface GatewayCredential {
  username: string;
  salt: string;
  hash: string;
  mustChangePassword: boolean;
}

interface Session {
  username: string;
  expiresAt: number;
}

const sessions = new Map<string, Session>();

let cached: GatewayCredential | null = null;

function hashPassword(password: string, salt: string) {
  return crypto.scryptSync(password, Buffer.from(salt, 'hex'), 64).toString('hex');
}

function timingSafeEqualHex(a: string, b: string) {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

function writeCredential(credential: GatewayCredential) {
  writeFileAtomic(CREDENTIAL_PATH, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 });
  cached = credential;
}

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

export function loadCredential(): GatewayCredential {
  if (cached) return cached;
  try {
    const doc = JSON.parse(fs.readFileSync(CREDENTIAL_PATH, 'utf8'));
    if (
      doc &&
      typeof doc.username === 'string' &&
      typeof doc.salt === 'string' &&
      typeof doc.hash === 'string' &&
      typeof doc.mustChangePassword === 'boolean'
    ) {
      cached = {
        username: doc.username,
        salt: doc.salt,
        hash: doc.hash,
        mustChangePassword: doc.mustChangePassword,
      };
      return cached;
    }
  } catch {
  }
  return createDefault();
}

export function mustChangePassword() {
  return loadCredential().mustChangePassword;
}

export function username() {
  return loadCredential().username;
}

export function verifyPassword(user: string, password: string) {
  const credential = loadCredential();
  if (user !== credential.username) {
    hashPassword(password, credential.salt);
    return false;
  }
  return timingSafeEqualHex(hashPassword(password, credential.salt), credential.hash);
}

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

export function sessionFromCookie(cookieHeader: any) {
  if (typeof cookieHeader !== 'string') return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'gw_session') return rest.join('=') || null;
  }
  return null;
}

export function sessionCookie(sid: string) {
  return `gw_session=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

export function clearCookie() {
  return 'gw_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

export function resetForTests() {
  cached = null;
  sessions.clear();
}
