// WorkBuddy 自助登录：网页登录 + 轮询取 token，完全不碰桌面客户端。它不是标准 OAuth2——没有 client
// 凭据、没有 PKCE、也没有 code→token 兑换，更接近 RFC 8628 设备码流程的简化版（device_code + user_code
// 合并成一个 state）。收益：拿到的 token 是**明文 JWT**，不像客户端本地文件那样套着 `$wbEncrypted` 信封。

import { pathToFileURL } from 'node:url';

import type { LoginResult } from '../../types.ts';
import { CHAT_BASE, workBuddyUserAgent } from './auth.ts';

const PREFIX_PATH = '/plugin';
// auth/state 的 platform 参数。客户端取自 product.json 的 authentication.attributes.platform。
const PLATFORM = 'workbuddy';
/** 客户端写死的「还在等用户操作」返回码。 */
const PENDING_CODE = 11217;
const POLL_INTERVAL_MS = 1000;
/** 单次轮询的超时。比 `TIMEOUT_MS` 短：轮询本身应该秒回，慢就说明这次网络有问题、下次再试。 */
const LOGIN_POLL_TIMEOUT_MS = 10_000;
/** 整个登录流程的总时长上限（用户可能一直在浏览器里不点）。**和 `TIMEOUT_MS` 不是一个东西**：那个是单次 HTTP 请求超时。 */
const LOGIN_TOTAL_TIMEOUT_MS = 5 * 60 * 1000;
const DOMAIN = 'www.workbuddy.cn';

// 实测登录接口不校验 UA（用 curl 裸调也能过），这里用客户端的串保底。版本号与 `auth.ts` 同源，别另抄一份。
function userAgent() {
  return workBuddyUserAgent();
}

/** 登录态接口的公共头：这四个 `X-No-*` 是客户端用来关掉自动注入的认证信息的。 */
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

/** 可被 signal 打断的 sleep，避免用户点「重新登录」后旧循环还要等满 1 秒。 */
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

/** ① 创建登录会话，拿到 state 和给用户看的登录页地址。 */
async function createAuthState() {
  const response = await fetch(`${CHAT_BASE}/v2${PREFIX_PATH}/auth/state?platform=${PLATFORM}`, {
    method: 'POST',
    headers: loginHeaders(),
    body: '{}',
    signal: AbortSignal.timeout(LOGIN_TOTAL_TIMEOUT_MS),
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

/** ③ 轮询直到用户登录完成。 */
async function pollToken(state: string, signal?: AbortSignal) {
  const deadline = Date.now() + LOGIN_TOTAL_TIMEOUT_MS;
  const url = `${CHAT_BASE}/v2${PREFIX_PATH}/auth/token?state=${encodeURIComponent(state)}`;
  let attempt = 0;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS, signal);
    attempt += 1;
    // 取消可能来自「用户又点了一次登录」，也可能来自「用户点了退出」——后者由 server.ts 的
    // /v1/logout 先 abort 再登出，否则挂起的登录会在授权完成时把凭据写回去、把刚点下的退出复活。
    if (signal?.aborted) throw new Error('登录已取消');
    try {
      const response = await fetch(url, { headers: loginHeaders(), signal: AbortSignal.timeout(LOGIN_POLL_TIMEOUT_MS) });
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
      // 只有网络层错误才继续轮询；业务错误（上面那条 throw）直接冒出去。
      if (typeof error?.message === 'string' && error.message.startsWith('换取凭据失败')) throw error;
      if (signal?.aborted) throw new Error('登录已取消');
      console.log(`[workbuddy] 第 ${attempt} 次轮询出错，继续：${error?.message ?? error}`);
    }
  }
  throw new Error('5 分钟没有完成登录');
}

/**
 * ④ 用 token 取一次账号信息，拿 uid 和昵称。失败不算致命——登录本身已经成功，只是面板上会少个名字。
 */
async function fetchAccount(state: string, accessToken: string) {
  try {
    const response = await fetch(`${CHAT_BASE}/v2${PREFIX_PATH}/login/account?state=${encodeURIComponent(state)}`, {
      headers: loginHeaders({ Authorization: `Bearer ${accessToken}` }),
      signal: AbortSignal.timeout(LOGIN_TOTAL_TIMEOUT_MS),
    });
    const doc: any = await response.json();
    const data = doc && doc.data;
    return data && typeof data === 'object' ? data : null;
  } catch (error: any) {
    console.log(`[workbuddy] 取账号信息失败（不影响登录）：${error?.message ?? error}`);
    return null;
  }
}

/** 把 `expiresIn`（秒）换成绝对时间；字段缺失时给保守默认值。 */
function epochFromSeconds(seconds: unknown, fallbackDays: number) {
  const value = typeof seconds === 'number' && seconds > 0 ? seconds : 0;
  return Date.now() + (value || fallbackDays * 24 * 3600) * 1000;
}

/**
 * 跑一次登录。拿到的凭据**不写盘**，交给账号层（`core/accounts.ts`）落进 `gateway.db` 的 `account` 表。
 * **不负责打开浏览器**：网关是无头服务，有浏览器的那台通常是用户自己的，这里只把地址交出去。
 * @param options.onUrl 拿到登录页地址时回调一次，供面板显示并打开。
 * @param options.signal 用户再点一次登录时会被 abort，这里要立刻收摊。
 */
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
    // expiresIn / refreshExpiresIn 都是秒；实测 30 天 / 60 天。
    expiresAt: epochFromSeconds(token.expiresIn, 30),
    refreshExpiresAt: epochFromSeconds(token.refreshExpiresIn, 60),
    domain: typeof token.domain === 'string' && token.domain ? token.domain : DOMAIN,
    uid: account && typeof account.uid === 'string' ? account.uid : '',
    username: account && typeof account.nickname === 'string' ? account.nickname : '',
    source: 'login',
  };
  // **不写盘**：凭据归账号层（`core/accounts.ts`），存到哪、算第几号账号都是网关的事。
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

// 直接 `node src/channels/workbuddy/login.ts` 时执行；被 channel.login() import 时不执行。
const entry = process.argv[1];
const isMain = entry ? import.meta.url === pathToFileURL(entry).href : false;
if (isMain) {
  runWorkBuddyLogin({}).catch((error) => {
    console.error(`\n登录失败：${error && error.message ? error.message : error}`);
    process.exitCode = 1;
  });
}
