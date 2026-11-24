// Trae CN 的凭据：刷新 + 请求头。
//
// 这里只管**只有 Trae 上游知道**的东西：令牌怎么刷、DeviceProof 怎么签、请求头长
// 什么样。凭据只有一个来源——账号文件，由登录流程写入、由账号层传进来。
//
// 设备密钥对（登录时生成的 EC P-256）跟着凭据一起存，因为刷新时的签名必须用
// **登录时注册的那把**，换一对必然验签失败。

import crypto from 'node:crypto';

import type { TraeCredential } from '../../types.ts';
import { credentialExpired, credentialUnavailable } from '../../shared/credential-error.ts';

const DEFAULT_REFRESH_BASE = 'https://api.trae.cn';
const EXCHANGE_PATH = '/cloudide/api/v3/trae/oauth/ExchangeToken';
const IDE_VERSION = '3.3.104';
const IDE_VERSION_CODE = '20260929';
const APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8';
/** OAuth 客户端 id，登录换令牌和后续刷新都用它（取自客户端的 product.json）。 */
export const TRAE_CLIENT_ID = 'ono9krqynydwx5';

// 对话走这个上游。Trae 把对话流量从 api.trae.cn 移走了（那边 agent 路由现在 404），
// 改由这个 host 提供。
export const TRAE_CHAT_BASE = 'https://trae-api-cn.mchost.guru';

/**
 * 客户端身份串：报给上游的版本号。**值由通道声明**（`traeChannel.identity`），
 * 启动时经 `configureTraeIdentity()` 传进来；这里只留一份默认值兜底，供单独跑
 * `npm run login` 这类没有经过 `configure()` 的场景使用。
 *
 * `clientVersion` 是桌面端 `product.json` 的 `version`（上游拿它当「客户端够不够新」
 * 的门禁，写错会得到 401 `20405 Device proof required`）；`buildVersion` 是同文件
 * 的 `tronBuildVersion`（授权 URL 的 `plugin_version`）。两者不是一个东西。
 */
export let TRAE_CLIENT_VERSION = '1.107.1';
export let TRAE_BUILD_VERSION = '2.3.100185';
/**
 * 账号接口（签到/额度）的 `x-app-version` 头。product.json 的 `appVersion`。
 *
 * 版本号写死会烂（和 `clientVersion` 同一个坑），所以收进 identity 由通道自述，
 * 这里只留一份默认值兜「没走 `configure()`」的场景（`npm run login`）。
 */
export let TRAE_APP_VERSION = '3.4.17';

/** 启动时由通道把自述身份注入进来。没调用过就沿用上面的默认值。 */
export function configureTraeIdentity(identity: { clientVersion?: string; channelVersion?: string; appVersion?: string }) {
  if (typeof identity.clientVersion === 'string' && identity.clientVersion) TRAE_CLIENT_VERSION = identity.clientVersion;
  if (typeof identity.channelVersion === 'string' && identity.channelVersion) TRAE_BUILD_VERSION = identity.channelVersion;
  if (typeof identity.appVersion === 'string' && identity.appVersion) TRAE_APP_VERSION = identity.appVersion;
}

let logSink: any = null;

export function setTraeLogger(fn: any) {
  logSink = fn;
}

function log(...args: unknown[]) {
  if (logSink) logSink(`[trae-auth] ${args.join(' ')}`);
}

// ---------------------------------------------------------------- 凭据形状

/**
 * 把上游返回的凭据字段归一化。
 *
 * 字段名有两套，这里都要认：
 *   - 换令牌接口 / 桌面客户端：`expiredAt` / `refreshExpiredAt` / `account.username` / `host`
 *   - 账号文件里存下来的：`expiresAt` / `refreshExpiresAt` / `username` / `refreshBase`
 *
 * 只认一套那版踩过：读缓存时有效期一律变成 0，于是每次都被判定成「不如另一份长寿」，
 * 刚写进去的令牌当场被覆盖——面板还显示登录成功，实际用的是旧的那套，白登一次。
 *
 * 导出是给 `test/credential.mjs` 用的：两种形状都要能读回来，这条不能靠肉眼。
 */
export function normalizeCredential(auth: any) {
  const accountName = auth.account && typeof auth.account.username === 'string' ? auth.account.username : '';
  return {
    token: auth.token,
    refreshToken: typeof auth.refreshToken === 'string' ? auth.refreshToken : '',
    userId: typeof auth.userId === 'string' ? auth.userId : '',
    username: accountName || (typeof auth.username === 'string' ? auth.username : ''),
    // 刷新走账号 host，对话走专门的 API host。两者分开存，别混。
    refreshBase: pickBase(auth.host) || pickBase(auth.refreshBase) || DEFAULT_REFRESH_BASE,
    expiresAt: firstEpoch(auth.expiredAt, auth.expiresAt),
    refreshExpiresAt: firstEpoch(auth.refreshExpiredAt, auth.refreshExpiresAt),
    machineId: typeof auth.machineId === 'string' ? auth.machineId : '',
    // aha 注册过的设备号；只有账号类接口（签到领取）需要它。为空表示回退到 selfDeviceId。
    checkinDeviceId: typeof auth.checkinDeviceId === 'string' ? auth.checkinDeviceId : '',
    // 本机自造的兜底设备号，见 `effectiveDeviceId()`。
    selfDeviceId: typeof auth.selfDeviceId === 'string' ? auth.selfDeviceId : '',
    /** 登录时生成的 EC P-256 密钥对。刷新要拿私钥签 DeviceProof，公钥要原样回填。 */
    privateKeyPEM: typeof auth.privateKeyPEM === 'string' ? auth.privateKeyPEM : '',
    publicKeyPEM: typeof auth.publicKeyPEM === 'string' ? auth.publicKeyPEM : '',
    source: auth.source || 'login',
  };
}

/**
 * 造一个 16 位十进制设备号，和客户端 aha 注册回来的同形。
 *
 * 用随机数而不是拿硬件指纹去算：我们复刻不了 metasecml 的签名流程，也没必要——
 * 这个号的作用只是让服务端能把「一个账号的签到状态」和别处区分开，
 * 它不需要可验证、不需要跨机器复现，只需要**这个账号稳定**。
 */
export function mintSelfDeviceId() {
  // 逐位生成：`crypto.randomInt` 的上限是 2^48，一次要 10^15 会直接抛
  // ERR_OUT_OF_RANGE，所以别图省事写成一次 randomInt(0, 10**15)。
  let id = String(crypto.randomInt(1, 10));
  for (let i = 0; i < 15; i += 1) id += String(crypto.randomInt(0, 10));
  return id;
}

/**
 * 账号接口该用哪个设备号。
 *
 * 优先级：aha 注册号 → 该账号自己的自造号。`machineId`（64 位十六进制遥测号）
 * **不参与**：它不是账号接口认的设备身份。
 *
 * ## 为什么自造号是「每账号一份」
 *
 * 上游按**设备**记签到：同一个账号今天用不同 `x-device-id` 查
 * `checkin_credits/status`，只有真正发过 claim 的那个号是 `did_checked_in: true`。
 * 而客户端一台机器只登一个号，所以一台机器上多个 Trae 账号不该共用一个设备号。
 *
 * 所以 `selfDeviceId` 存在该账号的凭据里（`Account.credential`），跟着账号走。
 *
 * **它和 9074 无关**：9074 是上游活动侧的瞬时爆满（见 `usage.ts` 的
 * `TRANSIENT_BIZ_CODES`），换设备号不是解药。
 *
 * **`checkinDeviceId`（aha 真号）仍然优先**：那是客户端真实注册过的号，比自造的更
 * 可能被上游接受。但它只在从 Windows 客户端导入凭据时才有，容器里通常为空。
 */
export function effectiveDeviceId(credential: any) {
  const real = typeof credential?.checkinDeviceId === 'string' ? credential.checkinDeviceId : '';
  if (real) return real;
  const self = typeof credential?.selfDeviceId === 'string' ? credential.selfDeviceId : '';
  return self;
}

/** 取第一个能解析成时间戳的值。 */
function firstEpoch(...values: any[]) {
  for (const value of values) {
    const epoch = toEpoch(value);
    if (epoch) return epoch;
  }
  return 0;
}

/**
 * 从 JWT 的 `exp` 取过期时间。
 *
 * 换令牌/刷新的返回里到底哪个字段是有效期，实测 `TokenExpireAt` 是空的（害得
 * 登录换来的令牌被记成「14 天后过期」的假值）。token 本身就是 JWT，`exp` 是
 * 权威答案，不用猜字段名。
 */
export function jwtExpiry(token: unknown) {
  if (typeof token !== 'string') return 0;
  const parts = token.split('.');
  if (parts.length !== 3) return 0;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

function pickBase(value: any) {
  if (typeof value !== 'string' || value === '') return '';
  return value.replace(/\/+$/u, '');
}

/** Trae 存的是 ISO 字符串，但时间戳数字也得认。 */
function toEpoch(value: any) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

// ---------------------------------------------------------------- 设备证明

/**
 * 从凭据里取设备密钥对。
 *
 * 私钥只用于刷新签名，公钥要原样回填到 `DeviceInfo.DevicePublicKey`——服务端存的
 * 就是登录时注册的那一把，换一对必然验签失败。所以密钥必须**跟着凭据走**：
 * 放在一个共用文件里的话，第二个账号登录就会把第一个账号的密钥覆盖掉。
 */
function deviceKeyOf(credential: any): { privateKeyPEM: string; publicKeyPEM: string } {
  const privateKeyPEM = typeof credential?.privateKeyPEM === 'string' ? credential.privateKeyPEM : '';
  const publicKeyPEM = typeof credential?.publicKeyPEM === 'string' ? credential.publicKeyPEM : '';
  if (!privateKeyPEM || !publicKeyPEM) {
    // 设备密钥缺失是**永久性**的：刷多少次都签不出 DeviceProof，只能重新登录。
    throw credentialExpired('这套 Trae 凭据里没有设备密钥（登录时随凭据一起存），签不出 DeviceProof，请重新登录');
  }
  return { privateKeyPEM, publicKeyPEM };
}

/**
 * 刷新要带的设备证明。
 *
 * 逆向自客户端 `exchangeTokenByRefreshToken` / `ZLe()`：签名内容是 6 行、用 `\n`
 * 连接 ——
 *
 *   POST\n/cloudide/api/v3/trae/oauth/ExchangeToken\n<ClientID>\n<RefreshToken>\n<秒级时间戳>\n<nonce>
 *
 * 第 2 行是**刷新**那个端点（`api.trae.cn/cloudide/api/v3/...`），和 `login.ts`
 * 换 AuthCode 用的 `/trae/api/v3/oauth/ExchangeToken` 不是一个路径，别照抄那边。
 *
 * nonce 是 16 字节随机数的 hex，签名是 SHA-256 的 ECDSA（EC P-256 私钥），base64。
 * 少了这段 `DeviceProof`，刷新接口只会回一个笼统的失败——这就是「令牌一过期就
 * 再也救不回来」的真正原因，而不是 RefreshToken 本身失效。
 *
 * **换令牌（AuthCode → Token）也要这一段**。2026-11-09 在容器里登录时实测：
 * 不带签名直接 401 `{"Code":"20405","Message":"Device proof required."}`。
 * 同一个端点、同一种签名形状，只是第 4 行换成 AuthCode——所以这里把参数叫 `token`，
 * 两种调用共用，签名格式只有一份。
 */
export function deviceProof(token: string, key: { privateKeyPEM: string }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString('hex');
  const canonical = ['POST', EXCHANGE_PATH, TRAE_CLIENT_ID, token, String(timestamp), nonce].join('\n');
  const signature = crypto.sign('sha256', Buffer.from(canonical), key.privateKeyPEM).toString('base64');
  return { Signature: signature, Timestamp: timestamp, Nonce: nonce };
}

/** 客户端 `_buildDeviceInfo()` 的同形结构。字段名大小写和服务端一致，别改。 */
function deviceInfo(credential: any, key: { publicKeyPEM: string }) {
  return {
    DeviceID: effectiveDeviceId(credential),
    MachineID: credential.machineId || '',
    PlatformCode: 'IDE_PC',
    DeviceType: 'PC',
    DeviceName: process.env.COMPUTERNAME || 'PC',
    DeviceModel: '',
    ClientVersion: TRAE_CLIENT_VERSION,
    DevicePublicKey: key.publicKeyPEM,
    DeviceBrand: '',
    DeviceCPU: '',
    OSInfo: 'Windows',
    OSVersion: '10',
  };
}

// ---------------------------------------------------------------- 刷新

/**
 * 用 refreshToken 换一对新令牌。
 *
 * 返回值交给 `usableCredential()` 写回账号文件——这里**不碰磁盘**。
 */
export async function refreshTraeCredential(credential: TraeCredential): Promise<TraeCredential> {
  if (!credential.refreshToken) throw credentialExpired('没有可用的 Trae refreshToken，请重新登录');
  const key = deviceKeyOf(credential);
  const base = credential.refreshBase || DEFAULT_REFRESH_BASE;
  let response;
  try {
    response = await fetch(`${base}${EXCHANGE_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 客户端 getHeaders(accessToken) 就带这一格；即使它已过期也照样带。
        'x-cloudide-token': credential.token || '',
      },
      body: JSON.stringify({
        ClientID: TRAE_CLIENT_ID,
        // 客户端这里就是空串，不是占位符。
        ClientSecret: '',
        RefreshToken: credential.refreshToken,
        DeviceInfo: deviceInfo(credential, key),
        DeviceProof: deviceProof(credential.refreshToken, key),
        IDEVersion: TRAE_CLIENT_VERSION,
      }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (error: any) {
    throw credentialUnavailable(`Trae 刷新令牌请求失败：${error.message}`);
  }
  const text = await response.text();
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw credentialUnavailable(`Trae token refresh returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`);
  }
  if (!response.ok) {
    const detail = `Trae token refresh failed (http ${response.status}): ${text.slice(0, 200)}`;
    // 4xx：refreshToken 被拒（过期/已用/设备证明不对），重试没有意义。
    // 5xx：上游在抖，下次可能就好，别把账号封成 invalid。
    throw response.status >= 400 && response.status < 500 ? credentialExpired(detail) : credentialUnavailable(detail);
  }
  const result = doc && doc.Result ? doc.Result : doc;
  if (!result || typeof result.Token !== 'string' || result.Token === '') {
    throw credentialExpired(`Trae token refresh returned no token: ${text.slice(0, 200)}`);
  }
  const next: TraeCredential = {
    ...credential,
    token: result.Token,
    refreshToken: typeof result.RefreshToken === 'string' && result.RefreshToken !== '' ? result.RefreshToken : credential.refreshToken,
    expiresAt: toEpoch(result.TokenExpireAt) || toEpoch(result.ExpireAt) || jwtExpiry(result.Token) || Date.now() + 3600 * 1000,
    // 来源照旧：`login` 换来的这套刷过一次之后仍然是「自助登录」的凭据。
    source: credential.source,
  };
  log(`trae token refreshed, expires ${new Date(next.expiresAt).toISOString()}`);
  return next;
}

/**
 * Trae 后端认的请求头，照客户端自己发的那一套填。
 *
 * `x-device-id` 是 `sha256(machineId)` 的前 32 位（见 `private/docs/trae-recon.md` §3）；
 * `machineId` 为空时这个头就整个不发。
 */
export function traeHeaders(credential: any) {
  const machineId = credential.machineId || '';
  const deviceId = machineId ? crypto.createHash('sha256').update(machineId).digest('hex').substring(0, 32) : '';
  const headers: Record<string, string> = {
    Authorization: `Cloud-IDE-JWT ${credential.token}`,
    'X-Cloudide-Token': credential.token,
    'x-uid': credential.userId || '',
    'x-app-id': APP_ID,
    'x-machine-id': machineId,
    'x-request-id': crypto.randomUUID(),
    'x-ide-version': IDE_VERSION,
    'x-ide-version-code': IDE_VERSION_CODE,
    'x-device-type': 'windows',
    'x-os-version': 'Windows 10',
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (deviceId) headers['x-device-id'] = deviceId;
  return headers;
}
