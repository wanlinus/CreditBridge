// Loomy（讯飞）凭据与账号服务。登录态只有**一个**字段：讯飞账号的 `session`，没有 refresh token，
// 所以 `refreshLoomyCredential` 直接抛错而不是去上游换令牌。
// 两个域名两套认证别混：`account.xfinfr.com` 走 HMAC-SHA1 签名，`loomyad.xunfei.cn/api/v1`
// 走 `token` 头 + `Authorization: Bearer`。应用级密钥随客户端分发，不是用户凭据（用户身份在 session 里）。

import crypto from 'node:crypto';

import type { AccountProfile } from '../../types.ts';
import { credentialExpired } from '../../shared/credential-error.ts';
import { generateAccountHeaders } from './sign.ts';

/** 账号服务 base。客户端 `loadEnvConfig` 的默认值是 accounttest，生产 `.env.prod` 覆盖成这个。 */
export const LOOMY_ACCOUNT_BASE = 'https://account.xfinfr.com';
/** 对话 / 模型 / 余额的统一入口。客户端 `_applyManagedProviderRuntimeConfig` 在积分网关后拼 `/api/v1`。 */
export const LOOMY_API_BASE = 'https://loomyad.xunfei.cn/api/v1';
/** 积分网关（余额走它下面的 `/api/v1/points/...`，和 LOOMY_API_BASE 同源）。 */
export const LOOMY_POINTS_BASE = 'https://loomyad.xunfei.cn';

/** 应用级密钥（随客户端分发，见文件头）。 */
const APP_ID = 'GM3LOOMY';
const ACCESS_KEY_ID = '2thryby66wxi53sk';
const ACCESS_KEY_SECRET = 'zsak6eadrbawz683wf5r3m2snrwj868r';

/** 客户端版本：`loomy-version` 头 + 通道 identity 都用它。 */
export const LOOMY_VERSION = '0.9.39';

/** 客户端 `_makeBase()` 的固定字段。`ua` 里写死 macOS 是客户端自己的 bug，照抄以对齐指纹。 */
const UA = 'Loomy|Desktop|Electron|macOS';

/** session 名义有效期（毫秒）。客户端在 checkCode 里对服务端声明 `expire: 14*24*3600` 秒。 */
export const SESSION_TTL_MS = 14 * 24 * 3600 * 1000;

let logSink: any = null;
export function setLoomyLogger(fn: any) {
  logSink = fn;
}
function log(...args: unknown[]) {
  if (logSink) logSink(`[loomy-auth] ${args.join(' ')}`);
}

/** Loomy 凭据。session 是唯一令牌，没有 refresh。 */
export interface LoomyCredential {
  session: string;
  userId: string;
  phone: string;
  /** 登录时刻 + 14 天（服务端声明的有效期）。用于 `usableCredential` 的本地过期判断。 */
  expiresAt: number;
  source: string;
}

/**
 * 无刷新机制：session 到期只能重新短信登录。**必须是 `permanent`**——抛裸 Error 会被上层包成 502，
 * 而 502 不改账号状态，过期的号就永远显示「就绪」，用户只看到「所有模型都报错」。
 */
export async function refreshLoomyCredential(_credential: LoomyCredential): Promise<LoomyCredential> {
  throw credentialExpired('Loomy 会话没有 refresh token，到期后请重新登录');
}

/** `_makeBase()` 的同形结构：账号服务每个请求体都带它。 */
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

/** 账号服务的通用响应信封：`{ code, desc, data }`，成功时 `code === '000000'`。 */
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

/**
 * ① 发短信验证码，返回 `msgid`（② 校验时要用）。手机号先在本地按 `/^1[3-9]\d{9}$/` 校验，
 * 错误提前报，别让服务端给一句笼统的失败。
 */
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

/** ② 校验验证码，换 session + userid。 */
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

/**
 * ③ 用 session 取账号信息（昵称、手机号）。登录后拿昵称当账号默认 label；
 * 失败不致命（登录本身已成功，只是少个名字）。
 */
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

/**
 * 生成 W3C traceparent。**对话必须带它**：实测 Loomy iModel 缺 traceparent 时
 * `/chat/completions` 会挂死直到超时。模型 / 余额接口则不需要。
 */
export function generateTraceparent(): string {
  return `00-${crypto.randomBytes(16).toString('hex')}-${crypto.randomBytes(8).toString('hex')}-01`;
}

/**
 * 对话 / 模型 / 余额共用的请求头。客户端 `useSessionAuth` 时**同时**带 `Authorization: Bearer <session>`
 * 和 `token: <session>`（兼容 Loomy iModel 两种入参），两个都别漏。
 */
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
