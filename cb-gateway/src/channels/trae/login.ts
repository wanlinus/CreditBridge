// Trae 的自助登录：生成 EC P-256 密钥对 + PKCE → 开本地 HTTP 回调 → 浏览器授权 → 用授权码换令牌。
// 坑一：换令牌**不需要**私钥签名（私钥只在后续 refresh 的 DeviceProof 里用），
// 而 `20405 Device proof required` 其实是「客户端版本太旧 / DeviceID 对不上」的门禁。
// 坑二：回调 `host` 是换令牌的域（`api.trae.com.cn`），refresh 走的是 `api.trae.cn` 的另一条路径，混用会让令牌一过期就再也刷不回来。
// 用法：`npm run login -- trae`；**不会替你开浏览器**，也**不写盘**（凭据归账号层）。

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
// 下面几个渠道串取自客户端自己的登录日志（main.log 的 `OAuthenticator# openLogin getLoginUrl`）。
// 服务端按它们分支，填错会卡在授权页的「认证中」，所以必须和当前客户端保持一致。
const APP_TYPE = 'stable';
const CHANNEL_NAME = 'common';
const DEVICE_BRAND = 'System Product Name';
const OS_VERSION = 'Windows 10 Pro for Workstations';
const AUTH_PATH = '/authorization';
const EXCHANGE_PATH = '/trae/api/v3/oauth/ExchangeToken';
const CALLBACK_PATH = '/authorize';
const TIMEOUT_MS = 5 * 60 * 1000;

/** 回调服务绑哪个地址/端口、对外声明的回调地址从哪来。**必须可配**：默认是「监听 127.0.0.1 随机端口、并把 `http://127.0.0.1:<port>/authorize` 交给上游」，这套在容器里必然失败——浏览器在用户机器上打开， 127.0.0.1 指的是那台机器；随机端口也无法提前发布。
 * 用 `QB_TRAE_LOGIN_HOST/PORT` + `QB_TRAE_CALLBACK_BASE` 覆盖，容器里 base 必须显式给（绑 0.0.0.0 时拼出来的地址访问不了）。实测登录页对 auth_callback_url 没有白名单校验。 */
function loginBind() {
  const rawPort = Number(process.env.QB_TRAE_LOGIN_PORT || 0);
  const port = Number.isFinite(rawPort) && rawPort >= 0 && rawPort <= 65535 ? rawPort : 0;
  const host = (process.env.QB_TRAE_LOGIN_HOST || '127.0.0.1').trim() || '127.0.0.1';
  return { host, port };
}

/** 交给上游的 auth_callback_url 的前缀，不带结尾斜杠。 */
function callbackBaseFor(port: number, bindHost: string) {
  const explicit = (process.env.QB_TRAE_CALLBACK_BASE || '').trim();
  if (explicit) return explicit.replace(/\/+$/u, '');
  // 绑 0.0.0.0 时拼出来的地址访问不了，但至少让日志和请求里能看到「配漏了」
  const host = bindHost === '0.0.0.0' || bindHost === '::' ? '127.0.0.1' : bindHost;
  return `http://${host}:${port}`;
}

/** 登录回调要的「环回端口」，给通道的 `loginLoopback()` 用——网关据此通过 SSE 告诉插件「在那台机器上把 127.0.0.1:<port> 转过来」。
 * 和 `runTraeLogin()` **共用** `loginBind()` / `callbackBaseFor()`：两处各读一遍环境变量迟早会漂移，插件就去转发一个错端口。返回 `null`：端口是随机的（外部没法预告），或回调地址不是环回（不需要转发）。 */
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

/** 上一次登录留下的设备标识，尽量复用，避免换设备触发风控。 */
interface Identity {
  machineId: string;
  deviceId: string;
  /** 没有 aha 注册号时用的自造设备号；重新登录不能把它丢掉。 */
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

/** 本机 `machineId`。登录用、**跨登录稳定**、全机一份，只存这一项（`selfDeviceId` 是账号级的东西，跟着账号凭据走）。
 * **必须落盘**：容器/Linux 上没有 Trae IDE，授权 URL 的 `machine_id=` 会是空的，而空值是从没验证过的路径（容器里登录会一直「登录失败」）。 */
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
    // `deviceId`（aha 注册的真号）跟着账号凭据走；自助登录的账号一律拿不到它。
    deviceId: '',
    // **自造号是账号级的**：这里留空，由 `save()` 按账号生成。
    // **故意不读老文件里的这个键**——读回来会让新账号继续用那个全机共用的号，多号共用设备号会互相干扰签到。
    selfDeviceId: '',
    userId: '',
  };

  // machineId 缺失就补一个并落盘：下次登录必须拿到同一个值，否则服务端当成新机器。
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
  // `deviceId` 必须非空：授权页会把它原样转给 `GetPCAuthCode`，空串上游回 `10101 无效参数`。
  // 这里和 `DeviceInfo.DeviceID` 必须用同一个值。
  const deviceId = identity.deviceId || identity.selfDeviceId;
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
    // 客户端会带一个空的 x_env；服务端可能按键是否存在做判断，所以保留空串。
    x_env: '',
    x_app_version: TRAE_CLIENT_VERSION,
    x_app_type: APP_TYPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    channel_name: CHANNEL_NAME,
  });
  return `${CONSOLE_HOST}${AUTH_PATH}?${params.toString()}`;
}

/** 登录页：先确认登录态，再回跳授权页。**这才是该直接打开的那个**——授权页被直接访问时，浏览器里已有 Trae 登录态的那次会停在页面上不再跳转（第二次登录必现：回调端口收不到请求，任务空转到 5 分钟超时）。
 * 客户端自己的 `openLogin getLoginUrl` 拿到的正是这个地址。 */
function buildLoginUrl(authorizeUrl: string): string {
  return `${CONSOLE_HOST}/login?login_platform=trae&redirect_url=${encodeURIComponent(authorizeUrl)}`;
}

/** 回调的 query 里都可能有什么。现在的授权页把授权码包在 `authCodeInfo` 里（JSON 字符串、键名大写 `AuthCode`），早期抓包是 `authCode`/`auth_code`/`code`——只认前者会卡在「回调里没有授权码」。
 * 同一次回调还告诉我们：`host`（换令牌该打哪个域，实测 `api.trae.com.cn`，和硬编码的 `api.trae.cn` **不是同一个域**）、`userInfo`（登录的是谁，换令牌的返回里不一定有用户名）。 */
interface CallbackInfo {
  code: string;
  key: string;
  host: string;
  userId: string;
  username: string;
}

/** 回调里允许的换令牌域名。query 是浏览器可控的，不白名单就等于让任意站点把授权码引去别处。 */
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
    // userInfo 解析不了不影响流程：换令牌的返回里通常也有 UserID。
    return { userId: '', username: '' };
  }
}

/** 导出是为了能直接用真实回调串核对——这段解析错一次就登不上。 */
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
      // authCodeInfo 不是 JSON 就继续试下一个字段名。
    }
  }
  return null;
}

/** 用授权码换令牌。`DeviceInfo.DeviceID` 必须和授权 URL 里的 `device_id` 是同一个值—— 两处不一致时上游回 `401 20405 Device proof required`（看着像缺签名，实际是它认不出这个 DeviceID）。
 * `DevicePublicKey` 会被服务端记在这个账号名下、之后每次刷新拿它验 `DeviceProof`，所以私钥必须和令牌一起存： **换一对密钥等于换一个设备**，丢了就只能重新登录。 */
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
      // **必须和授权 URL 里的 `device_id` 是同一个值。** 两处不一致时上游换令牌回
      // `401 20405 Device proof required`——看着像缺签名，实际是它认不出「这个 DeviceID 是谁」。
      // 上游对空 DeviceID 一律回 `10101 无效参数`，所以这个号在登录开始时就必须生成。
      DeviceID: identity.deviceId || identity.selfDeviceId,
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
    // **刻意不带 DeviceProof**：官方换令牌从不带签名（只有 refresh 带），加签名只会更乱。
  };
  const base = host || API_HOST;
  // 打一行摘要：上游对「客户端够不够新 / 设备认不认得」的判断全看这几个字段，出问题时光看
  // 错误码猜不到（20405 说的是签名，实际是版本或 DeviceID）。只打非敏感字段。
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

/**
 * 换令牌成功后的收尾：把令牌和设备密钥对**一起装进凭据对象**交出去（**不写盘**，存成哪一号
 * 账号是账号层的活）。密钥对必须跟凭据走，放共用文件里会被下一个账号覆盖。
 */
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
    // 这里**不**用回调给的 host：那个是「换令牌」的域，而后续 refresh 走的是桌面客户端那套
    // （api.trae.cn + /cloudide/api/v3/trae/oauth/ExchangeToken）。混用会让第一次 token 过期后就再也刷新不回来。
    refreshBase: API_HOST,
    expiresAt: epoch(result.TokenExpireAt) || epoch(result.ExpireAt) || jwtExpiry(result.Token) || Date.now() + 14 * 24 * 3600 * 1000,
    refreshExpiresAt: epoch(result.RefreshExpireAt) || Date.now() + 180 * 24 * 3600 * 1000,
    machineId: identity.machineId,
    checkinDeviceId: identity.deviceId,
    // **每个账号一份自造设备号**，登录完成的瞬间就补齐（否则签到时 `x-device-id` 是空串并回 9004）。
    // **必须沿用登录时用的那个号**：上游在 `GetPCAuthCode` / `ExchangeToken` 阶段就把令牌绑在这个
    // DeviceID 上，另造一个等于换了一台设备。
    selfDeviceId: identity.deviceId ? '' : identity.selfDeviceId || mintSelfDeviceId(),
    // 设备密钥对跟着凭据走：刷新签名必须用登录时注册的那一把，放共用文件里会被下一个账号覆盖。
    privateKeyPEM: keyPair.privateKeyPEM,
    publicKeyPEM: keyPair.publicKeyPEM,
    source: 'login',
  };
  // **不写盘**：凭据归账号层（`core/accounts.ts`）。
  return credential;
}

/**
 * 跑一次交互式登录，成功后返回凭据（含设备密钥对）。**不负责打开浏览器**（网关是无头服务，
 * 有浏览器的通常是用户自己那台），**也不负责落盘**（存成哪一号账号是 `core/accounts.ts` 的事）。
 */
export async function runTraeLogin(
  options: { onUrl?: (url: string) => void; signal?: AbortSignal } = {},
): Promise<LoginResult> {
  const identity = previousIdentity();
  // **登录这一刻就必须有设备号。** 授权页把 `device_id` 原样转给 `GetPCAuthCode`，空串会被判
  // `10101 无效参数`、页面拿不到授权码也不跳回（表现是登录任务一直挂着）。
  // 实测：`DeviceID:''` → 400；任意非空值（16 位数字 / 32 hex / UUID）→ 200 带授权码。
  // 同一个号必须**同时**用到三处：授权 URL、`DeviceInfo.DeviceID`、凭据的 `selfDeviceId`；
  // 三处不一致时换令牌回 `401 20405 Device proof required`。
  if (!identity.deviceId && !identity.selfDeviceId) identity.selfDeviceId = mintSelfDeviceId();

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
  /** 绑回调端口：**被占用时先退避重试，再报可读的错误，绝不让进程崩**。两个坑叠在这里： ① 用户连点两次「添加账号」时，`server.close()` 是异步的，新任务的 `listen()` 立刻打过来就撞 EADDRINUSE；
   * ② bind 失败的 `'error'` 事件没人接，未捕获异常直接把整个网关带走（容器里就是一次重启）。 */
  await new Promise<void>((resolve, reject) => {
    let attempt = 0;
    const tryListen = () => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        if (error.code === 'EADDRINUSE' && attempt < 30) {
          attempt += 1;
          setTimeout(tryListen, 100);
          return;
        }
        reject(
          error.code === 'EADDRINUSE'
            ? new Error(`回调端口 ${bind.port} 已被占用——上一次登录任务还没结束（关掉那个授权页，或等 5 分钟超时），再重试`)
            : error,
        );
      };
      const onListening = () => {
        server.off('error', onError);
        server.on('error', (error) => console.error('[trae] 回调服务出错：' + String(error)));
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(bind.port, bind.host);
    };
    tryListen();
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : bind.port;
  const callbackBase = callbackBaseFor(port, bind.host);
  const authorizeUrl = buildAuthorizeUrl({ callbackBase, challenge, identity });
  const loginUrl = buildLoginUrl(authorizeUrl);
  console.log('回调服务：' + callbackBase + CALLBACK_PATH + `（监听 ${bind.host}:${port}）`);
  console.log('登录地址：' + loginUrl);
  console.log('授权地址：' + authorizeUrl);
  // 打开登录页而不是授权页：直接开授权页时，浏览器已有登录态的那次会停在页面上不跳转。
  options.onUrl?.(loginUrl);
  console.log('（请在浏览器打开上面的登录地址；网关不负责开浏览器）');

  // 用户再点一次「登录」或点「退出」时网关会 abort 掉上一次；这里要立刻收摊，不然旧任务会
  // 一直占着回调端口空转到 5 分钟超时。文案只说取消，不猜原因。
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
  console.log('  凭据不落盘：由网关按账号存进 gateway.db 的 account 表。');
  return {
    credential,
    profile: {
      uid: credential.userId,
      username: credential.username,
    },
    label: credential.username,
  };
}

// 直接 `node src/channels/trae/login.ts` 时执行；被 channel.login() import 时不执行。
const entry = process.argv[1];
const isMain = entry ? import.meta.url === pathToFileURL(entry).href : false;
if (isMain) {
  runTraeLogin({}).catch((error) => {
    console.error('\n登录失败：' + (error && error.message ? error.message : error));
    process.exitCode = 1;
  });
}
