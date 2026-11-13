import crypto from 'node:crypto';

import type { AccountProfile } from '../../types.ts';
import { credentialExpired } from '../../shared/credential-error.ts';
import { generateAccountHeaders } from './sign.ts';

export const LOOMY_ACCOUNT_BASE = 'https://account.xfinfr.com';
export const LOOMY_API_BASE = 'https://loomyad.xunfei.cn/api/v1';
export const LOOMY_POINTS_BASE = 'https://loomyad.xunfei.cn';

const APP_ID = 'GM3LOOMY';
const ACCESS_KEY_ID = '2thryby66wxi53sk';
const ACCESS_KEY_SECRET = 'zsak6eadrbawz683wf5r3m2snrwj868r';

export const LOOMY_VERSION = '0.9.39';

const UA = 'Loomy|Desktop|Electron|macOS';

export const SESSION_TTL_MS = 14 * 24 * 3600 * 1000;

let logSink: any = null;
export function setLoomyLogger(fn: any) {
  logSink = fn;
}
function log(...args: unknown[]) {
  if (logSink) logSink(`[loomy-auth] ${args.join(' ')}`);
}

export interface LoomyCredential {
  session: string;
  userId: string;
  phone: string;
  expiresAt: number;
  source: string;
}

export async function refreshLoomyCredential(_credential: LoomyCredential): Promise<LoomyCredential> {
  throw credentialExpired('Loomy 会话没有 refresh token，到期后请重新登录');
}

function makeBase() {
  return {
    appid: APP_ID,
    modelid: 'Web',
    version: '1.0.0',
    devid: 'web',
    ua: UA,
    traceid: crypto.randomUUID().replace(/-/g, ''),
  };
}

async function accountRequest(path: string, param: Record<string, unknown>): Promise<any> {
  const body = JSON.stringify({ base: makeBase(), param });
  const headers = generateAccountHeaders({
    accessKeyId: ACCESS_KEY_ID,
    accessKeySecret: ACCESS_KEY_SECRET,
    method: 'POST',
    path,
    body,
  });
  let response;
  try {
    response = await fetch(`${LOOMY_ACCOUNT_BASE}${path}`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(30000),
    });
  } catch (error: any) {
    throw new Error(`Loomy 账号服务网络错误（${path}）：${error.message}`);
  }
  const text = await response.text();
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(`Loomy 账号服务返回非 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`);
  }
  if (!response.ok) throw new Error(`Loomy 账号服务 HTTP ${response.status}（${path}）：${doc?.desc || text.slice(0, 160)}`);
  if (doc?.code && doc.code !== '000000') {
    throw new Error(`Loomy 账号服务业务错误（${path}）${doc.code}：${doc.desc || doc.message || '未知错误'}`);
  }
  return doc;
}

export async function sendSmsCode(phone: string): Promise<string> {
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    throw new Error('手机号格式不正确（中国大陆 11 位，1 开头）');
  }
  const doc = await accountRequest('/login/phone/sendMsgCode', {
    ccode: '86',
    phone,
    expire: 300,
  });
  const msgid = doc?.data?.msgid;
  if (typeof msgid !== 'string' || msgid === '') {
    throw new Error(`发短信失败：${doc?.desc || '服务端未返回 msgid'}`);
  }
  log(`短信验证码已发送（${phone.slice(0, 3)}****${phone.slice(-4)}），msgid=${msgid.slice(0, 8)}…`);
  return msgid;
}

export async function verifySmsCode(phone: string, code: string, msgid: string): Promise<{ session: string; userId: string; phone: string }> {
  const doc = await accountRequest('/login/phone/checkCode', {
    ccode: '86',
    phone,
    mcode: code,
    msgid,
    expire: 14 * 24 * 3600,
  });
  const data = doc?.data || {};
  const session = typeof data.session === 'string' ? data.session : '';
  const userId = typeof data.userid === 'string' ? data.userid : '';
  if (!session || !userId) {
    throw new Error(`验证码校验失败：${doc?.desc || '服务端未返回 session/userid'}`);
  }
  return { session, userId, phone };
}

export async function fetchUserInfo(session: string): Promise<AccountProfile | null> {
  try {
    const doc = await accountRequest('/userinfo/query/baseInfo', { session });
    const data = doc?.data || {};
    return {
      uid: typeof data.userid === 'string' ? data.userid : '',
      username: typeof data.nickname === 'string' && data.nickname !== '' ? data.nickname : '',
    };
  } catch (error: any) {
    log(`取账号信息失败（不影响登录）：${error.message}`);
    return null;
  }
}

export function generateTraceparent(): string {
  return `00-${crypto.randomBytes(16).toString('hex')}-${crypto.randomBytes(8).toString('hex')}-01`;
}

export function loomyApiHeaders(session: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session}`,
    token: session,
    'loomy-version': LOOMY_VERSION,
    ...extra,
  };
}
