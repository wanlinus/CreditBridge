import { credentialExpired, credentialUnavailable } from '../../shared/credential-error.ts';

const CN_CHAT_BASE = 'https://copilot.tencent.com';
const CN_BILLING_BASE = 'https://www.codebuddy.cn';
const PREFIX_PATH = '/plugin';

let logSink: any = null;
export function setLogger(fn: any) {
  logSink = fn;
}

function log(...args: unknown[]) {
  if (logSink) logSink(...args);
  else console.log(`[${new Date().toISOString()}] ${args.join(' ')}`);
}

let versions = { appVersion: '5.9.3', cliVersion: '2.165.0' };

export function workBuddyVersions() {
  return versions;
}

export function configureWorkBuddy(identity: { clientVersion?: string; channelVersion?: string }) {
  if (typeof identity.clientVersion === 'string' && identity.clientVersion) versions.appVersion = identity.clientVersion;
  if (typeof identity.channelVersion === 'string' && identity.channelVersion) versions.cliVersion = identity.channelVersion;
}

function cliUserAgent() {
  return `CLI/${versions.cliVersion} CodeBuddy/${versions.cliVersion}`;
}

function desktopUserAgent() {
  return `WorkBuddy/${versions.appVersion} WorkBuddy/${versions.appVersion} CLI/${versions.cliVersion}`;
}

export async function refreshWorkBuddyCredential(credential: any) {
  if (!credential || typeof credential.refreshToken !== 'string' || credential.refreshToken === '') {
    throw credentialExpired('没有可用的 WorkBuddy refreshToken，请重新登录');
  }
  let response;
  try {
    response = await fetch(`${CN_CHAT_BASE}/v2${PREFIX_PATH}/auth/token/refresh`, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: CN_BILLING_BASE,
        Referer: `${CN_BILLING_BASE}/`,
        'User-Agent': cliUserAgent(),
        'X-Refresh-Token': credential.refreshToken,
        'X-Auth-Refresh-Source': 'workbuddy',
      },
      signal: AbortSignal.timeout(30000),
    });
  } catch (error: any) {
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
    throw response.status >= 400 && response.status < 500
      ? credentialExpired(detail)
      : credentialUnavailable(detail);
  }
  const data = doc.data && typeof doc.data === 'object' ? doc.data : {};
  if (typeof data.accessToken !== 'string' || data.accessToken === '') {
    throw credentialExpired('WorkBuddy 刷新没有返回 accessToken，请重新登录');
  }
  const next = {
    ...credential,
    accessToken: data.accessToken,
    refreshToken: typeof data.refreshToken === 'string' && data.refreshToken !== '' ? data.refreshToken : credential.refreshToken,
    expiresAt: Date.now() + (typeof data.expiresIn === 'number' && data.expiresIn > 0 ? data.expiresIn * 1000 : 30 * 24 * 3600 * 1000),
    domain: typeof data.domain === 'string' && data.domain !== '' ? data.domain : credential.domain,
    source: credential.source,
  };
  log('token refreshed, expires', new Date(next.expiresAt).toISOString());
  return next;
}

export async function revokeWorkBuddySession(credential: any) {
  const refreshToken = credential && typeof credential.refreshToken === 'string' ? credential.refreshToken : '';
  if (!refreshToken) return false;
  try {
    const response = await fetch(`${CN_CHAT_BASE}/v2${PREFIX_PATH}/auth/logout`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Refresh-Token': refreshToken,
        'X-Auth-Refresh-Source': 'plugin',
        'X-No-Authorization': 'true',
        'X-Domain': credential.domain || 'www.workbuddy.cn',
        'User-Agent': desktopUserAgent(),
      },
      body: '{}',
      signal: AbortSignal.timeout(15000),
    });
    log(`server logout -> ${response.status}`);
    return response.ok;
  } catch (error: any) {
    log(`server logout failed: ${error.message}`);
    return false;
  }
}
