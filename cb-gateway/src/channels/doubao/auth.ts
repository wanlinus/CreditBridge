// 豆包凭据与请求头。凭据就是**一份 cookie 串**——登录有两条路（见 `login.ts`）：
// 短信验证码（单账号可全自助）或从客户端导入 cookie（多账号必须走这条）。
// 没有 refresh：sessionid 的 sid_guard 里声明 60 天，到期只能重新登录。
//
// 两个反直觉的点：
// ① **URL query 是必需的**，缺 device_id/fp 会回 `710010202 系统错误`，看着像登录过期。
// ② **错误码不能只看数字**：710010202 有三个来源（缺参数 / 该接口恒错 / cookie 过期），
//    判登录态只能用 quota/summary（它坏 cookie 回 710012001、好 cookie 回 0）。

import { credentialExpired } from '../../shared/credential-error.ts';
import type { AccountProfile } from '../../types.ts';

/** 所有出站请求的超时。上游挂起时无限等待会让整个通道卡死，必须每个 fetch 都带。 */
export const TIMEOUT_MS = 20_000;

export const WEB_BASE = 'https://www.doubao.com';
export const PASSPORT_BASE = 'https://accounts.doubao.com';

/** 豆包桌面端的 appId。所有接口都拿它当 `aid`。 */
const APP_ID = '1044603';
/** 默认 bot，模型表和执行请求都用它。 */
export const BOT_ID = '7338286299411103781';
/** 客户端发布渠道。`/version/upgrade/pull` 认这个值，写错回 `710012001 invalid gateway identity`。 */
const APP_CHANNEL = 'webdaoliu_sidebar_login_small_pcwork_windows';

/** 客户端版本。**值由通道声明**（`doubaoChannel.identity.clientVersion`），经 `configureIdentity()` 注入。 */
export let DOUBAO_VERSION = '';

export function configureIdentity(clientVersion: string): void {
  if (clientVersion) DOUBAO_VERSION = clientVersion;
}

let logSink: any = null;
export function setLogger(fn: any) {
  logSink = fn;
}
function log(...args: unknown[]) {
  if (logSink) logSink(`[doubao-auth] ${args.join(' ')}`);
}

/**
 * 豆包凭据。`cookies` 是 `name=value` 的有序对，不是一个大字符串——
 * 导出、合并、判过期都要按名字找，拼成串就没法查了。
 */
export interface DoubaoCredential {
  cookies: Record<string, string>;
  /** 设备号。客户端生成后长期复用，换号时可以不变。 */
  deviceId: string;
  /** 前端指纹，形如 `verify_<deviceId>`。 */
  webId: string;
  uid: string;
  /** cookie 里 `sid_guard` 声明的过期时间（毫秒）。取不到就是 null（那就永不在本地判过期）。 */
  expiresAt: number | null;
  source: string;
}

/** `sid_guard` 的形状：`{sessionid}|{签发秒}|{max_age 秒}|{HTTP 日期}`。 */
function expiryFromSidGuard(value: string): number | null {
  const parts = value.split('|');
  if (parts.length < 3) return null;
  const issued = Number(parts[1]);
  const maxAge = Number(parts[2]);
  if (!Number.isFinite(issued) || !Number.isFinite(maxAge) || issued <= 0 || maxAge <= 0) return null;
  return (issued + maxAge) * 1000;
}

/** 从 `multi_sids`（`{uid}:{sessionid}`）里取 uid。 */
function uidFromMultiSids(value: string): string {
  const at = value.indexOf(':');
  return at > 0 ? value.slice(0, at) : '';
}

/**
 * 解析用户贴进来的 cookie 串。接受三种写法：`a=1; b=2`、换行分隔、以及浏览器
 * 「复制为 JSON」那种。返回 null 表示没解析出任何一对。
 */
export function parseCookieString(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const text = String(raw || '').trim();
  if (!text) return out;

  // 整串 JSON 对象：`{"a":"1"}` 或 `[{"name":"a","value":"1"}]` 两种都认。
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const doc = JSON.parse(text);
      const list = Array.isArray(doc) ? doc : [doc];
      for (const item of list) {
        if (item && typeof item.name === 'string' && typeof item.value === 'string') out[item.name] = item.value;
      }
      if (Object.keys(out).length > 0) return out;
    } catch {
      /* 不是 JSON，按分隔符继续 */
    }
  }

  for (const piece of text.split(/[;\n\r]+/u)) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const at = trimmed.indexOf('=');
    if (at <= 0) continue;
    const name = trimmed.slice(0, at).trim();
    // cookie 值里可能有 `=`（base64 padding），只切第一个。
    const value = trimmed.slice(at + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

/** 把有序 cookie 对象拼回请求头。 */
export function cookieHeaderOf(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .filter(([, value]) => typeof value === 'string' && value !== '')
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

/** 必需的那几条。少 `sessionid` 直接判无效——省掉一次必然失败的请求。 */
const REQUIRED_COOKIES = ['sessionid'] as const;

/**
 * 把用户贴进来的串整理成凭据。**不验活**（那是 `probe` 的事）：这里只做形状校验，
 * 因为验活要发网络请求，而 `login()` 里已经单独做了一次。
 */
export function buildCredential(rawCookies: string, extra: { deviceId?: string; webId?: string } = {}): DoubaoCredential {
  return buildCredentialFromCookies(parseCookieString(rawCookies), extra);
}

/**
 * 从已经解析好的 cookie 对象建凭据。短信登录拿到的就是 Set-Cookie 解析后的对象，
 * 所以和「粘贴字符串」共用这一段——两个入口各写一遍的话，uid/expiresAt 的推导迟早分叉。
 */
export function buildCredentialFromCookies(
  cookies: Record<string, string>,
  extra: { deviceId?: string; webId?: string } = {},
): DoubaoCredential {
  for (const name of REQUIRED_COOKIES) {
    if (!cookies[name]) {
      throw new Error(`cookie 里没有 ${name}。请在浏览器或客户端里复制完整的 Cookie（含 sessionid）`);
    }
  }

  const sessionid = cookies.sessionid || '';
  // 设备号不在 cookie 里时按 sessionid 派生一个稳定的：同一份 cookie 永远是同一个号，
  // 换一个 cookie 就换一个号——比写死一个固定值安全。
  const deviceId = extra.deviceId || cookies.uid_tt || deriveDeviceId(sessionid);
  const webId = extra.webId || cookies.web_id || '0';
  const uid = uidFromMultiSids(cookies.multi_sids || '') || cookies.uid_tt || deviceId;

  return {
    cookies,
    deviceId,
    webId,
    uid,
    expiresAt: cookies.sid_guard ? expiryFromSidGuard(cookies.sid_guard) : null,
    source: 'login',
  };
}

/** 从 sessionid 派生 15 位十进制设备号（豆包的 device_id 就是这个形状）。 */
function deriveDeviceId(seed: string): string {
  let hash = 0n;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31n + BigInt(seed.charCodeAt(i))) % 1_000_000_000_000_000n;
  }
  return (hash % 9_000_000_000_000_000n + 1_000_000_000_000_000n).toString();
}

/**
 * 无 refresh 机制：cookie 到期只能重新导入。**必须是 `permanent`**——抛裸 Error 会被包成 502，
 * 而 502 不改账号状态，过期的号就永远显示「就绪」。
 */
export async function refreshDoubaoCredential(_credential: DoubaoCredential): Promise<DoubaoCredential> {
  throw credentialExpired('豆包没有刷新机制，cookie 过期后请重新导出导入');
}

/**
 * 业务接口的 query。**每一条都别删**：实测少 `device_id` / `fp` 会回 `710010202 系统错误`，
 * 那个错误码和「cookie 过期」长得一样，排查时很容易走错方向。
 */
export function webQuery(credential: DoubaoCredential): string {
  return new URLSearchParams({
    version_code: '20800',
    language: 'zh',
    device_platform: 'web',
    doubao_device_platform: 'desktop',
    aid: APP_ID,
    os: 'windows',
    real_aid: APP_ID,
    pkg_type: 'release_version',
    device_id: credential.deviceId,
    pc_version: DOUBAO_VERSION,
    doubao_pc_version: DOUBAO_VERSION,
    web_id: credential.webId,
    tea_uuid: credential.deviceId,
    region: 'CN',
    sys_region: 'CN',
    samantha_web: '1',
    web_platform: 'desktop',
    'use-olympus-account': '1',
    runtime: 'web',
    runtime_version: '3.47.0',
    client_platform: 'pc_client',
    chromium_version: '147.0.7727.149',
    channel: 'win',
    fp: `verify_${credential.deviceId}`,
  }).toString();
}

/** 客户端 UA。`SamanthaDoubaoWork/<版本>` 后缀是它自己的标记，别去掉。 */
export function userAgent(): string {
  return (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    `Chrome/147.0.0.0 Safari/537.36 SamanthaDoubaoWork/${DOUBAO_VERSION || '2.38.3'}`
  );
}

/** 业务接口的通用请求头。 */
export function webHeaders(credential: DoubaoCredential, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'User-Agent': userAgent(),
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    Referer: `${WEB_BASE}/`,
    Origin: WEB_BASE,
    Cookie: cookieHeaderOf(credential.cookies),
    ...extra,
  };
}

/**
 * 发一个业务接口请求并解出 JSON。**HTTP 200 不代表成功**：豆包的成功判据是内层 `code === 0`，
 * 光看状态码会把 `code:710010202` 当成功，然后拿一个空对象继续往下走。
 */
export async function postWeb(
  credential: DoubaoCredential,
  path: string,
  body: unknown,
  options: { timeoutMs?: number; signal?: AbortSignal; extraHeaders?: Record<string, string> } = {},
): Promise<any> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const url = `${WEB_BASE}${path}?${webQuery(credential)}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: webHeaders(credential, options.extraHeaders),
    body: JSON.stringify(body ?? {}),
    signal,
  });
  const text = await response.text();

  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(`豆包 ${path} 返回非 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    throw new Error(`豆包 ${path} HTTP ${response.status}：${String(doc?.msg || text).slice(0, 200)}`);
  }
  return doc;
}

/** 成功判定：`code === 0`。和 `postWeb` 分开，因为有的调用点要先看别的东西再判。 */
export function isOk(doc: any): boolean {
  return Boolean(doc) && doc.code === 0;
}

/**
 * 验一次凭据。返回 `null` 表示有效，否则是原因。
 *
 * **必须挑一个「坏 cookie 会拒」的接口**：`/alice/user/launch` 之类坏 cookie 也回 `code:0`，
 * 拿它验活会永远显示「就绪」，账号过期了也不知道。`quota/summary` 实测坏 cookie 回 `710012001`。
 * 抽到这里而不是放 `login.ts`：登录后校验和「检测」按钮共用同一份判据，各写一遍迟早分叉。
 */
export async function verifyCredential(credential: DoubaoCredential): Promise<string | null> {
  try {
    const doc = await postWeb(credential, '/alice/commerce/sale/subscription/quota/summary/', { product_line: 'membership' });
    if (isOk(doc)) return null;
    const code = Number(doc?.code);
    if (code === 710012001 || code === 710010202 || code === 710010101) return 'cookie 已失效或不属于这个账号';
    return `上游返回 ${code}：${doc?.msg || doc?.message || '未知错误'}`;
  } catch (error: any) {
    return error?.message || String(error);
  }
}

/**
 * 取账号信息（昵称 + uid）。**这条路走 passport，不带 `webQuery`**——
 * 它认的是 `aid` + `account_sdk_source`，多塞参数反而会被拒。
 * 失败不致命：登录本身已经成功，只是少个显示名。
 */
export async function fetchProfile(credential: DoubaoCredential): Promise<AccountProfile | null> {
  const query = new URLSearchParams({
    aid: APP_ID,
    account_sdk_source: 'web',
    sdk_version: '2.2.11-doubao.0',
    device_id: credential.deviceId,
    device_platform: 'web',
  });
  try {
    const response = await fetch(`${PASSPORT_BASE}/passport/account/info/v2/?${query}`, {
      headers: { 'User-Agent': userAgent(), Cookie: cookieHeaderOf(credential.cookies) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const doc = (await response.json()) as any;
    const data = doc?.data;
    if (!data || typeof data !== 'object') return null;
    return {
      uid: String(data.user_id_str || data.user_id || credential.uid || ''),
      username: typeof data.screen_name === 'string' && data.screen_name !== '' ? data.screen_name : String(data.name || ''),
    };
  } catch (error: any) {
    log(`取账号信息失败（不影响登录）：${error.message}`);
    return null;
  }
}

/** 版本查询要用的账号来源。由 `index.ts` 在 `configure()` 里接到账号层——
 * 反过来 import 会让 `auth → core/accounts` 和 `core/accounts → channels` 成环。 */
let versionAccountSource: (() => DoubaoCredential | null) | null = null;
export function setVersionAccountSource(source: () => DoubaoCredential | null): void {
  versionAccountSource = source;
}

/**
 * 查上游最新客户端版本（`/version/upgrade/pull`）。
 *
 * **这条要 cookie**：不带回 `710012001 invalid gateway identity`。
 * 所以没有可用账号时只能抛错——`channel-versions.ts` 会保留库里的旧值并标 `cached`，
 * 比静默返回空对象好：那种「查失败」和「上游没给版本」分不清。
 */
export async function fetchIdentity(): Promise<{ clientVersion: string }> {
  const credential = versionAccountSource?.() ?? null;
  if (!credential) throw new Error('没有可用的豆包账号，查不到最新版本');

  const response = await fetch(`${WEB_BASE}/version/upgrade/pull`, {
    method: 'POST',
    headers: webHeaders(credential),
    body: JSON.stringify({
      app_brand: 'doubao_work',
      channel: APP_CHANNEL,
      device_brand: 'ASUS',
      device_id: credential.deviceId,
      device_model: 'System Product Name',
      locale: 'zh',
      os_info: '10.0.19045',
      platform: 'windows_x64',
      version: DOUBAO_VERSION || '2.38.3',
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(`版本接口返回非 JSON（HTTP ${response.status}）：${text.slice(0, 160)}`);
  }
  if (Number(doc?.code) !== 0) {
    throw new Error(`版本接口 ${doc?.code}：${doc?.message || doc?.msg || '未知错误'}`);
  }
  // `has_new: false` 时 `data.data` 是 null，此时没有「最新版本」可报。
  const version = doc?.data?.data?.version;
  if (typeof version !== 'string' || version === '') {
    throw new Error('版本接口没有返回 version（可能已是最新，或该账号查不到升级信息）');
  }
  log(`上游最新版本 ${version}`);
  return { clientVersion: version };
}
