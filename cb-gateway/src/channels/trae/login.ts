import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { LoginResult, TraeCredential } from '../../types.ts';
import { STATE_DIR } from '../../shared/paths.ts';
import { writeFileAtomic } from '../../shared/atomic-write.ts';
import { jwtExpiry, mintSelfDeviceId, TRAE_BUILD_VERSION, TRAE_CLIENT_ID, TRAE_CLIENT_VERSION } from './auth.ts';

const CONSOLE_HOST = 'https://www.trae.cn';
const API_HOST = 'https://api.trae.cn';
const APP_TYPE = 'stable';
const CHANNEL_NAME = 'common';
const DEVICE_BRAND = 'System Product Name';
const OS_VERSION = 'Windows 10 Pro for Workstations';
const AUTH_PATH = '/authorization';
const EXCHANGE_PATH = '/trae/api/v3/oauth/ExchangeToken';
const CALLBACK_PATH = '/authorize';
const TIMEOUT_MS = 5 * 60 * 1000;

function loginBind() {
  const rawPort = Number(process.env.QB_TRAE_LOGIN_PORT || 0);
  const port = Number.isFinite(rawPort) && rawPort >= 0 && rawPort <= 65535 ? rawPort : 0;
  const host = (process.env.QB_TRAE_LOGIN_HOST || '127.0.0.1').trim() || '127.0.0.1';
  return { host, port };
}

function callbackBaseFor(port: number, bindHost: string) {
  const explicit = (process.env.QB_TRAE_CALLBACK_BASE || '').trim();
  if (explicit) return explicit.replace(/\/+$/u, '');
  const host = bindHost === '0.0.0.0' || bindHost === '::' ? '127.0.0.1' : bindHost;
  return `http://${host}:${port}`;
}

export function loginLoopback(): { port: number; path: string } | null {
  const bind = loginBind();
  const base = callbackBaseFor(bind.port, bind.host);
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  if (!/^(127\.0\.0\.1|localhost|\[::1\])$/u.test(url.hostname)) return null;
  const port = Number(url.port) || bind.port;
  if (!Number.isInteger(port) || port <= 0) return null;
  return { port, path: CALLBACK_PATH };
}

interface Identity {
  machineId: string;
  deviceId: string;
  selfDeviceId: string;
  userId: string;
}

interface KeyPair {
  privateKeyPEM: string;
  publicKeyPEM: string;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function makeKeyPair(): KeyPair {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privateKeyPEM: privateKey, publicKeyPEM: publicKey };
}

const IDENTITY_PATH = path.join(STATE_DIR, 'trae-identity.json');

function readIdentityFile() {
  try {
    return JSON.parse(fs.readFileSync(IDENTITY_PATH, 'utf8')) || {};
  } catch {
    return {};
  }
}

function previousIdentity(): Identity {
  const stored = readIdentityFile();

  const identity: Identity = {
    machineId: typeof stored.machineId === 'string' ? stored.machineId : '',
    deviceId: '',
    selfDeviceId: '',
    userId: '',
  };

  if (!identity.machineId) {
    identity.machineId = crypto.randomBytes(32).toString('hex');
    try {
      writeFileAtomic(IDENTITY_PATH, `${JSON.stringify({ machineId: identity.machineId }, null, 2)}\n`);
      console.log(`[trae] 本机没有 machineId，已补一份并落盘：${identity.machineId.slice(0, 8)}…`);
    } catch (error: any) {
      console.log(`[trae] 写机器身份失败：${error.message}（本次仍会用临时值登录）`);
    }
  }
  return identity;
}

function buildAuthorizeUrl({ callbackBase, challenge, identity }: { callbackBase: string; challenge: string; identity: Identity }): string {
  const callback = `${callbackBase}${CALLBACK_PATH}`;
  const deviceId = identity.deviceId || identity.selfDeviceId || '';
  const params = new URLSearchParams({
    login_version: '1',
    auth_from: 'trae',
    login_channel: 'native_ide',
    plugin_version: TRAE_BUILD_VERSION,
    auth_type: 'local',
    client_id: TRAE_CLIENT_ID,
    redirect: '0',
    login_trace_id: crypto.randomUUID(),
    auth_callback_url: callback,
    machine_id: identity.machineId,
    device_id: deviceId,
    x_device_id: deviceId,
    x_machine_id: identity.machineId,
    x_device_brand: DEVICE_BRAND,
    x_device_type: 'windows',
    x_os_version: OS_VERSION,
    x_env: '',
    x_app_version: TRAE_CLIENT_VERSION,
    x_app_type: APP_TYPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    channel_name: CHANNEL_NAME,
  });
  return `${CONSOLE_HOST}${AUTH_PATH}?${params.toString()}`;
}

function buildLoginUrl(authorizeUrl: string): string {
  return `${CONSOLE_HOST}/login?login_platform=trae&redirect_url=${encodeURIComponent(authorizeUrl)}`;
}

interface CallbackInfo {
  code: string;
  key: string;
  host: string;
  userId: string;
  username: string;
}

const ALLOWED_HOSTS = ['https://api.trae.cn', 'https://api.trae.com.cn'];

function callbackHost(url: URL) {
  const raw = url.searchParams.get('host');
  if (!raw) return '';
  const normalized = raw.replace(/\/+$/u, '');
  return ALLOWED_HOSTS.includes(normalized) ? normalized : '';
}

function callbackUser(url: URL): { userId: string; username: string } {
  const raw = url.searchParams.get('userInfo');
  if (!raw) return { userId: '', username: '' };
  try {
    const user = JSON.parse(raw);
    return {
      userId: user && typeof user.UserID === 'string' ? user.UserID : '',
      username: user && typeof user.ScreenName === 'string' ? user.ScreenName : '',
    };
  } catch {
    return { userId: '', username: '' };
  }
}

export function parseCallback(url: URL): CallbackInfo | null {
  const rest = () => ({ host: callbackHost(url), ...callbackUser(url) });
  for (const key of ['authCodeInfo', 'authCode', 'auth_code', 'code']) {
    const raw = url.searchParams.get(key);
    if (!raw) continue;
    if (key !== 'authCodeInfo') return { code: raw, key, ...rest() };
    try {
      const info = JSON.parse(raw);
      if (info && typeof info.AuthCode === 'string' && info.AuthCode !== '') {
        return { code: info.AuthCode, key, ...rest() };
      }
    } catch {
    }
  }
  return null;
}

async function exchangeToken({
  code,
  verifier,
  keyPair,
  identity,
  host,
}: {
  code: string;
  verifier: string;
  keyPair: KeyPair;
  identity: Identity;
  host: string;
}): Promise<any> {
  const body = {
    ClientID: TRAE_CLIENT_ID,
    AuthCode: code,
    CodeVerifier: verifier,
    DeviceInfo: {
      DeviceID: identity.deviceId || identity.selfDeviceId || '',
      MachineID: identity.machineId,
      PlatformCode: 'IDE_PC',
      DeviceType: 'PC',
      DeviceName: process.env.COMPUTERNAME || 'PC',
      DeviceModel: '',
      ClientVersion: TRAE_CLIENT_VERSION,
      DevicePublicKey: keyPair.publicKeyPEM,
      DeviceBrand: '',
      DeviceCPU: '',
      OSInfo: 'Windows',
      OSVersion: '10',
    },
    IDEVersion: TRAE_CLIENT_VERSION,
  };
  const base = host || API_HOST;
  console.log(
    `[trae] 换令牌 body: ClientID=${body.ClientID} IDEVersion=${body.IDEVersion} ` +
      `DeviceID=${body.DeviceInfo.DeviceID || '(空)'} MachineID=${String(body.DeviceInfo.MachineID).slice(0, 8)}… ` +
      `ClientVersion=${body.DeviceInfo.ClientVersion} host=${base}`,
  );
  const response = await fetch(`${base}${EXCHANGE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cloudide-token': '' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`换令牌 HTTP ${response.status} (${base}): ${text.slice(0, 400)}`);
  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(`换令牌返回非 JSON: ${text.slice(0, 400)}`);
  }
  const result = doc && doc.Result ? doc.Result : doc;
  if (!result || typeof result.Token !== 'string' || result.Token === '') {
    throw new Error(`换令牌没有返回 Token: ${text.slice(0, 400)}`);
  }
  return result;
}

function epoch(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

function save({ result, keyPair, identity, userHint }: {
  result: any;
  keyPair: KeyPair;
  identity: Identity;
  userHint: { userId: string; username: string };
}) {
  const credential: TraeCredential = {
    token: result.Token,
    refreshToken: typeof result.RefreshToken === 'string' ? result.RefreshToken : '',
    userId: typeof result.UserID === 'string' ? result.UserID : userHint.userId || identity.userId,
    username: typeof result.UserName === 'string' ? result.UserName : userHint.username,
    refreshBase: API_HOST,
    expiresAt: epoch(result.TokenExpireAt) || epoch(result.ExpireAt) || jwtExpiry(result.Token) || Date.now() + 14 * 24 * 3600 * 1000,
    refreshExpiresAt: epoch(result.RefreshExpireAt) || Date.now() + 180 * 24 * 3600 * 1000,
    machineId: identity.machineId,
    checkinDeviceId: identity.deviceId,
    selfDeviceId: identity.deviceId ? '' : mintSelfDeviceId(),
    privateKeyPEM: keyPair.privateKeyPEM,
    publicKeyPEM: keyPair.publicKeyPEM,
    source: 'login',
  };
  return credential;
}

export async function runTraeLogin(
  options: { onUrl?: (url: string) => void; signal?: AbortSignal } = {},
): Promise<LoginResult> {
  const identity = previousIdentity();

  const { verifier, challenge } = pkce();
  const keyPair = makeKeyPair();

  let resolveCode!: (value: CallbackInfo) => void;
  let rejectCode!: (error: unknown) => void;
  const finished = new Promise<CallbackInfo>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end('not found');
      return;
    }
    console.log('\n回调收到：' + url.pathname + '?' + url.search.slice(1, 300));
    const found = parseCallback(url);
    if (!found) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('回调里没有授权码');
      rejectCode(new Error('回调里没有授权码，完整 query 见上方'));
      return;
    }
    console.log(`授权码字段名：${found.key}`);
    if (found.host) console.log(`换令牌域名：${found.host}`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<h2>登录成功，可以关掉这个页面了</h2>');
    resolveCode(found);
  });

  const bind = loginBind();
  await new Promise<void>((resolve) => server.listen(bind.port, bind.host, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : bind.port;
  const callbackBase = callbackBaseFor(port, bind.host);
  const authorizeUrl = buildAuthorizeUrl({ callbackBase, challenge, identity });
  const loginUrl = buildLoginUrl(authorizeUrl);
  console.log('回调服务：' + callbackBase + CALLBACK_PATH + `（监听 ${bind.host}:${port}）`);
  console.log('登录地址：' + loginUrl);
  console.log('授权地址：' + authorizeUrl);
  options.onUrl?.(loginUrl);
  console.log('（请在浏览器打开上面的登录地址；网关不负责开浏览器）');

  const onAbort = () => rejectCode(new Error('登录已取消'));
  options.signal?.addEventListener('abort', onAbort, { once: true });

  const timer = setTimeout(() => rejectCode(new Error('5 分钟没有完成登录')), TIMEOUT_MS);
  let callback: CallbackInfo;
  try {
    callback = await finished;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    server.close();
  }

  console.log('正在用授权码换令牌…');
  const result = await exchangeToken({ code: callback.code, verifier, keyPair, identity, host: callback.host });
  const credential = save({ result, keyPair, identity, userHint: callback });
  console.log('\n登录成功');
  console.log('  userId    : ' + credential.userId);
  console.log('  token 到期: ' + new Date(credential.expiresAt).toLocaleString('zh-CN'));
  console.log('  refresh   : ' + new Date(credential.refreshExpiresAt).toLocaleString('zh-CN'));
  console.log('  凭据不落盘：由网关按账号存进 data/accounts/trae/。');
  return {
    credential,
    profile: {
      uid: credential.userId,
      username: credential.username,
    },
    label: credential.username,
  };
}

const entry = process.argv[1];
const isMain = entry ? import.meta.url === pathToFileURL(entry).href : false;
if (isMain) {
  runTraeLogin({}).catch((error) => {
    console.error('\n登录失败：' + (error && error.message ? error.message : error));
    process.exitCode = 1;
  });
}
