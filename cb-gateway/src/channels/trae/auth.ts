import crypto from 'node:crypto';

import type { TraeCredential } from '../../types.ts';
import { credentialExpired, credentialUnavailable } from '../../shared/credential-error.ts';

const DEFAULT_REFRESH_BASE = 'https://api.trae.cn';
const EXCHANGE_PATH = '/cloudide/api/v3/trae/oauth/ExchangeToken';
const IDE_VERSION = '3.3.104';
const IDE_VERSION_CODE = '20260929';
const APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8';
export const TRAE_CLIENT_ID = 'ono9krqynydwx5';

export const TRAE_CHAT_BASE = 'https://trae-api-cn.mchost.guru';

export let TRAE_CLIENT_VERSION = '1.107.1';
export let TRAE_BUILD_VERSION = '2.3.100185';
export let TRAE_APP_VERSION = '3.4.17';

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
  if (logSink) logSink(...args);
}

export function normalizeCredential(auth: any) {
  const accountName = auth.account && typeof auth.account.username === 'string' ? auth.account.username : '';
  return {
    token: auth.token,
    refreshToken: typeof auth.refreshToken === 'string' ? auth.refreshToken : '',
    userId: typeof auth.userId === 'string' ? auth.userId : '',
    username: accountName || (typeof auth.username === 'string' ? auth.username : ''),
    refreshBase: pickBase(auth.host) || pickBase(auth.refreshBase) || DEFAULT_REFRESH_BASE,
    expiresAt: firstEpoch(auth.expiredAt, auth.expiresAt),
    refreshExpiresAt: firstEpoch(auth.refreshExpiredAt, auth.refreshExpiresAt),
    machineId: typeof auth.machineId === 'string' ? auth.machineId : '',
    checkinDeviceId: typeof auth.checkinDeviceId === 'string' ? auth.checkinDeviceId : '',
    selfDeviceId: typeof auth.selfDeviceId === 'string' ? auth.selfDeviceId : '',
    privateKeyPEM: typeof auth.privateKeyPEM === 'string' ? auth.privateKeyPEM : '',
    publicKeyPEM: typeof auth.publicKeyPEM === 'string' ? auth.publicKeyPEM : '',
    source: auth.source || 'login',
  };
}

export function mintSelfDeviceId() {
  let id = String(crypto.randomInt(1, 10));
  for (let i = 0; i < 15; i += 1) id += String(crypto.randomInt(0, 10));
  return id;
}

export function effectiveDeviceId(credential: any) {
  const real = typeof credential?.checkinDeviceId === 'string' ? credential.checkinDeviceId : '';
  if (real) return real;
  const self = typeof credential?.selfDeviceId === 'string' ? credential.selfDeviceId : '';
  return self;
}

function firstEpoch(...values: any[]) {
  for (const value of values) {
    const epoch = toEpoch(value);
    if (epoch) return epoch;
  }
  return 0;
}

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

function toEpoch(value: any) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

function deviceKeyOf(credential: any): { privateKeyPEM: string; publicKeyPEM: string } {
  const privateKeyPEM = typeof credential?.privateKeyPEM === 'string' ? credential.privateKeyPEM : '';
  const publicKeyPEM = typeof credential?.publicKeyPEM === 'string' ? credential.publicKeyPEM : '';
  if (!privateKeyPEM || !publicKeyPEM) {
    throw credentialExpired('这套 Trae 凭据里没有设备密钥（登录时随凭据一起存），签不出 DeviceProof，请重新登录');
  }
  return { privateKeyPEM, publicKeyPEM };
}

export function deviceProof(token: string, key: { privateKeyPEM: string }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString('hex');
  const canonical = ['POST', EXCHANGE_PATH, TRAE_CLIENT_ID, token, String(timestamp), nonce].join('\n');
  const signature = crypto.sign('sha256', Buffer.from(canonical), key.privateKeyPEM).toString('base64');
  return { Signature: signature, Timestamp: timestamp, Nonce: nonce };
}

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
        'x-cloudide-token': credential.token || '',
      },
      body: JSON.stringify({
        ClientID: TRAE_CLIENT_ID,
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
    source: credential.source,
  };
  log(`trae token refreshed, expires ${new Date(next.expiresAt).toISOString()}`);
  return next;
}

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
