import { pathToFileURL } from 'node:url';

import type { LoginResult } from '../../types.ts';
import { workBuddyVersions } from './auth.ts';

const API_BASE = 'https://copilot.tencent.com';
const PREFIX_PATH = '/plugin';
const PLATFORM = 'workbuddy';
const PENDING_CODE = 11217;
const POLL_INTERVAL_MS = 1000;
const TIMEOUT_MS = 5 * 60 * 1000;
const DOMAIN = 'www.workbuddy.cn';

function userAgent() {
  const versions = workBuddyVersions();
  return `WorkBuddy/${versions.appVersion} WorkBuddy/${versions.appVersion} CLI/${versions.cliVersion}`;
}

function loginHeaders(extra: Record<string, string> = {}) {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-No-Authorization': 'true',
    'X-No-User-Id': 'true',
    'X-No-Enterprise-Id': 'true',
    'X-No-Department-Info': 'true',
    'X-Domain': DOMAIN,
    'User-Agent': userAgent(),
    ...extra,
  };
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('登录已取消'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function createAuthState() {
  const response = await fetch(`${API_BASE}/v2${PREFIX_PATH}/auth/state?platform=${PLATFORM}`, {
    method: 'POST',
    headers: loginHeaders(),
    body: '{}',
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(`创建登录会话返回非 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`);
  }
  const data = doc && doc.data;
  if (doc.code !== 0 || !data || typeof data.state !== 'string' || !data.state) {
    throw new Error(`创建登录会话失败：HTTP ${response.status} code=${doc && doc.code} msg=${doc && doc.msg}`);
  }
  return { state: data.state as string, authUrl: typeof data.authUrl === 'string' ? data.authUrl : '' };
}

async function pollToken(state: string, signal?: AbortSignal) {
  const deadline = Date.now() + TIMEOUT_MS;
  const url = `${API_BASE}/v2${PREFIX_PATH}/auth/token?state=${encodeURIComponent(state)}`;
  let attempt = 0;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS, signal);
    attempt += 1;
    if (signal?.aborted) throw new Error('登录已取消');
    try {
      const response = await fetch(url, { headers: loginHeaders(), signal: AbortSignal.timeout(10000) });
      const doc: any = await response.json();
      if (doc && doc.code === PENDING_CODE) {
        if (attempt % 30 === 0) console.log(`[workbuddy] 仍在等待网页登录…（${attempt}s）`);
        continue;
      }
      const data = doc && doc.data;
      if (doc && doc.code === 0 && data && typeof data.accessToken === 'string' && data.accessToken) {
        return data;
      }
      throw new Error(`换取凭据失败：HTTP ${response.status} code=${doc && doc.code} msg=${doc && doc.msg}`);
    } catch (error: any) {
      if (typeof error?.message === 'string' && error.message.startsWith('换取凭据失败')) throw error;
      if (signal?.aborted) throw new Error('登录已取消');
      console.log(`[workbuddy] 第 ${attempt} 次轮询出错，继续：${error?.message ?? error}`);
    }
  }
  throw new Error('5 分钟没有完成登录');
}

async function fetchAccount(state: string, accessToken: string) {
  try {
    const response = await fetch(`${API_BASE}/v2${PREFIX_PATH}/login/account?state=${encodeURIComponent(state)}`, {
      headers: loginHeaders({ Authorization: `Bearer ${accessToken}` }),
      signal: AbortSignal.timeout(15000),
    });
    const doc: any = await response.json();
    const data = doc && doc.data;
    return data && typeof data === 'object' ? data : null;
  } catch (error: any) {
    console.log(`[workbuddy] 取账号信息失败（不影响登录）：${error?.message ?? error}`);
    return null;
  }
}

function epochFromSeconds(seconds: unknown, fallbackDays: number) {
  const value = typeof seconds === 'number' && seconds > 0 ? seconds : 0;
  return Date.now() + (value || fallbackDays * 24 * 3600) * 1000;
}

export async function runWorkBuddyLogin(
  options: { onUrl?: (url: string) => void; signal?: AbortSignal } = {},
): Promise<LoginResult> {
  const { state, authUrl } = await createAuthState();
  console.log(`[workbuddy] 登录会话 state=${state}`);
  console.log(`[workbuddy] 登录地址 ${authUrl}`);
  options.onUrl?.(authUrl);
  console.log('[workbuddy] 请在浏览器打开上面的登录地址；网关不负责开浏览器');

  const token = await pollToken(state, options.signal);
  const account = await fetchAccount(state, token.accessToken);

  const credential = {
    accessToken: token.accessToken,
    refreshToken: typeof token.refreshToken === 'string' ? token.refreshToken : '',
    expiresAt: epochFromSeconds(token.expiresIn, 30),
    refreshExpiresAt: epochFromSeconds(token.refreshExpiresIn, 60),
    domain: typeof token.domain === 'string' && token.domain ? token.domain : DOMAIN,
    uid: account && typeof account.uid === 'string' ? account.uid : '',
    username: account && typeof account.nickname === 'string' ? account.nickname : '',
    source: 'login',
  };
  console.log(
    `[workbuddy] 登录成功 uid=${credential.uid || '(未知)'} 名字=${credential.username || '(未知)'} ` +
      `到期=${new Date(credential.expiresAt).toLocaleString('zh-CN')}`,
  );
  return {
    credential,
    profile: {
      uid: credential.uid,
      username: credential.username,
      domain: credential.domain,
    },
    label: credential.username,
  };
}

const entry = process.argv[1];
const isMain = entry ? import.meta.url === pathToFileURL(entry).href : false;
if (isMain) {
  runWorkBuddyLogin({}).catch((error) => {
    console.error(`\n登录失败：${error && error.message ? error.message : error}`);
    process.exitCode = 1;
  });
}
