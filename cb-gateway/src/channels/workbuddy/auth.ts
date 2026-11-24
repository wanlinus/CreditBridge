// WorkBuddy 凭据：刷新 + 注销 + 请求头要的版本串。凭据归账号层（`core/accounts.ts`）管，
// 过期判断和并发刷新都在 `usableCredential()`。
// 坑：版本号过期**不会得到明确的错误**——上游回的那句看起来像签名问题。

import { credentialExpired, credentialUnavailable } from '../../shared/credential-error.ts';
import type { IdentityPatch } from '../../types.ts';

/** 所有出站请求的超时。上游挂起时无限等待会让整个通道卡死，必须每个 fetch 都带。 */
export const TIMEOUT_MS = 20_000;

export const CHAT_BASE = 'https://copilot.tencent.com';
export const BILLING_BASE = 'https://www.codebuddy.cn';
/** 账号与登录接口都挂在 `/v2/plugin` 下（product.json 的 authentication.attributes.prefixPath）。 */
const PREFIX_PATH = '/plugin';

let logSink: any = null;
export function setLogger(fn: any) {
  logSink = fn;
}

function log(...args: unknown[]) {
  if (logSink) logSink(`[workbuddy-auth] ${args.join(' ')}`);
}

/**
 * 报给上游的客户端版本串。**不在这里写死**：版本号属于通道自述（`workbuddyChannel.identity`），
 * 启动时由 `configureIdentity()` 注入。`login-cli.ts` 也会走 `configure()`，所以不需要兜底值。
 */
const versions = { clientVersion: '', channelVersion: '', ideVersion: '' };

/** 更新源（`download.codebuddy.cn/workbuddy/saas/version.json`，8 个平台 × stable/gray）。 */
const VERSION_URL = 'https://download.codebuddy.cn/workbuddy/saas/version.json';

/**
 * 查上游最新版本。**读 Windows 桌面端那一档**（`win32-x64-system`），
 * 因为网关报的就是 Windows 头；Linux 包比它旧一截（实测 `5.6.2` vs `5.11.3`）。
 *
 * 版本串形如 `5.11.3.43806934-ecace0f7`：前三段是 `clientVersion`，
 * 第四段是构建号（`channelVersion`）。
 */
export async function fetchIdentity(): Promise<IdentityPatch> {
  const response = await fetch(VERSION_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`版本接口 HTTP ${response.status}`);
  const body = (await response.json()) as any;
  const raw = body?.['win32-x64-system']?.stable?.version;
  if (typeof raw !== 'string' || raw === '') throw new Error('version.json 里没有 win32-x64-system.stable.version');
  const [numeric] = raw.split('-');
  const parts = numeric.split('.');
  if (parts.length < 4) throw new Error(`版本串格式不认识：${raw}`);
  const main = parts.slice(0, 3).join('.');
  return { clientVersion: main, channelVersion: parts[3], ideVersion: main };
}

/**
 * 由通道在 `configure()` 里注入真实版本。**唯一的注入点**：`upstream.ts` / `models.ts` /
 * `login.ts` 都从这里取——各处自己接一个 `configure*()` 的话，加一个版本字段就要改四个文件。
 */
export function configureIdentity(identity: { clientVersion?: string; channelVersion?: string; ideVersion?: string }) {
  if (typeof identity.clientVersion === 'string' && identity.clientVersion) versions.clientVersion = identity.clientVersion;
  if (typeof identity.channelVersion === 'string' && identity.channelVersion) versions.channelVersion = identity.channelVersion;
  if (typeof identity.ideVersion === 'string' && identity.ideVersion) versions.ideVersion = identity.ideVersion;
}

/**
 * `WorkBuddy/<app> WorkBuddy/<app> CLI/<cli>` 形状的 UA。**对话、模型目录、登录轮询三处共用这一份**——
 * 原先三个文件各拼一遍，改版本号时漏一处就是一个带着旧版本号的请求。
 */
export function workBuddyUserAgent() {
  return `WorkBuddy/${versions.clientVersion} WorkBuddy/${versions.clientVersion} CLI/${versions.channelVersion}`;
}

/** `X-IDE-Version` 头。 */
export function workBuddyIdeVersion() {
  return versions.ideVersion;
}

/** `CLI/<cli> CodeBuddy/<cli>` 形状：刷新令牌时客户端发的就是这个 UA。 */
function cliUserAgent() {
  return `CLI/${versions.channelVersion} CodeBuddy/${versions.channelVersion}`;
}

/** 用 refreshToken 换新的一对 token，返回值交给 `usableCredential()` 写回账号——这里**不碰磁盘**。抛的必须是 `CredentialError` 并分清两类：refreshToken 缺失 / 上游 4xx → `permanent`（账号标 invalid），网络 / 5xx / 非 JSON → 暂时性、不动账号状态。
 * 混成裸 Error 会被包成 502，凭据过期后账号一直显示「就绪」。 */
export async function refreshWorkBuddyCredential(credential: any) {
  if (!credential || typeof credential.refreshToken !== 'string' || credential.refreshToken === '') {
    throw credentialExpired('没有可用的 WorkBuddy refreshToken，请重新登录');
  }
  let response;
  try {
    response = await fetch(`${CHAT_BASE}/v2${PREFIX_PATH}/auth/token/refresh`, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: BILLING_BASE,
        Referer: `${BILLING_BASE}/`,
        'User-Agent': cliUserAgent(),
        'X-Refresh-Token': credential.refreshToken,
        'X-Auth-Refresh-Source': 'workbuddy',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error: any) {
    // 连接超时/断网：重试有意义。
    throw credentialUnavailable(`WorkBuddy 刷新令牌请求失败：${error.message}`);
  }
  const text = await response.text();
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw credentialUnavailable(`token refresh returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`);
  }
  if (!response.ok || doc.code !== 0) {
    const detail = `token refresh failed (http ${response.status}, code ${doc.code}): ${String(doc.msg || text).slice(0, 200)}`;
    // 4xx 是上游明确拒绝（refreshToken 过期/被吊销）；5xx 是上游自己在抖。
    throw response.status >= 400 && response.status < 500
      ? credentialExpired(detail)
      : credentialUnavailable(detail);
  }
  const data = doc.data && typeof doc.data === 'object' ? doc.data : {};
  if (typeof data.accessToken !== 'string' || data.accessToken === '') {
    // 200 但没给 token：协议层面刷不出来了，重试没有意义。
    throw credentialExpired('WorkBuddy 刷新没有返回 accessToken，请重新登录');
  }
  const next = {
    ...credential,
    accessToken: data.accessToken,
    refreshToken: typeof data.refreshToken === 'string' && data.refreshToken !== '' ? data.refreshToken : credential.refreshToken,
    // expiresIn 是秒；缺失时按实测的 30 天兜底。
    expiresAt: Date.now() + (typeof data.expiresIn === 'number' && data.expiresIn > 0 ? data.expiresIn * 1000 : 30 * 24 * 3600 * 1000),
    domain: typeof data.domain === 'string' && data.domain !== '' ? data.domain : credential.domain,
    // 来源照旧：刷过一次之后仍然是「网页登录换来的」，不要降级。
    source: credential.source,
  };
  log('token refreshed, expires', new Date(next.expiresAt).toISOString());
  return next;
}

/**
 * 让服务端把这条会话注销掉（`POST /v2/plugin/auth/logout`）。失败不抛：本地登出照常进行，
 * 只是想尽力别在服务端留一条还能刷新的会话。
 */
export async function revokeWorkBuddySession(credential: any) {
  const refreshToken = credential && typeof credential.refreshToken === 'string' ? credential.refreshToken : '';
  if (!refreshToken) return false;
  try {
    const response = await fetch(`${CHAT_BASE}/v2${PREFIX_PATH}/auth/logout`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Refresh-Token': refreshToken,
        'X-Auth-Refresh-Source': 'plugin',
        'X-No-Authorization': 'true',
        'X-Domain': credential.domain || 'www.workbuddy.cn',
        'User-Agent': workBuddyUserAgent(),
      },
      body: '{}',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    log(`server logout -> ${response.status}`);
    return response.ok;
  } catch (error: any) {
    log(`server logout failed: ${error.message}`);
    return false;
  }
}
