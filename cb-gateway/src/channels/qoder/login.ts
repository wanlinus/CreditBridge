// Qoder 设备码登录流（自实现）：PKCE + nonce + machine_id 拼授权 URL，浏览器授权后轮询拿 `dt-`/`drt-`。
// 反直觉：拿到的 `dt-` 一次授权解决全部需求——`/sash/*` 直接打，对话则用它现算 COSY 签名输入；
// 「`dt-` 喂 CLI 被 `access_token_invalid` 拒」只适用于 CLI 的 accessToken 模式，与签名无关。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { LoginResult } from '../../types.ts';
import { STATE_DIR } from '../../shared/paths.ts';
import { writeFileAtomic } from '../../shared/atomic-write.ts';
import { deriveRuntimeFields } from './cosy/index.ts';
import type { QoderCredential } from './auth.ts';

// 授权/轮询的固定端点。CN 版：web 域名 qoder.cn、api 域名 qoder.com.cn。
const WEB_BASE = 'https://qoder.cn';
const OPENAPI_BASE = 'https://openapi.qoder.com.cn';
const AUTH_PATH = '/device/selectAccounts';
const POLL_PATH = '/api/v1/deviceToken/poll';

// CN 版的 client_id。`.19` 版把它用 XOR 混淆藏在 `Ofl`，解出来和 `.18` 版 recon 的值一致。
const CLIENT_ID = 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb';

// 官方 CLI 的 `User-Agent: qoder/<version>`。**这是唯一的版本号来源**：`/health` 的
// `clientVersion`、请求头的 `cosy-version`、模型列表的 `minimal_version.cli` 门禁都要跟它一致。
export const QODER_CLI_VERSION = '1.1.79-hotfix.19';

const USER_AGENT = `qoder/${QODER_CLI_VERSION}`;

// 轮询节奏，和 CLI 一致：间隔 1 秒，总超时 5 分钟。
const POLL_INTERVAL_MS = 1000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** machine_id 的落点。设备号必须跨登录稳定，否则服务端会当成「新设备」。这里不碰硬件—— 容器里读 `/etc/machine-id` 不稳定（镜像重建会变），所以自造 UUID 落盘复用。
 * **UUID 就够**：设备号在授权 URL 里只是标识、不参与验签（对比 Trae 的 DeviceID 会影响验签）， poll 阶段甚至不带它。 */
const IDENTITY_PATH = path.join(STATE_DIR, 'qoder-identity.json');

export function loadOrCreateMachineId(): string {
  try {
    const doc = JSON.parse(fs.readFileSync(IDENTITY_PATH, 'utf8'));
    if (typeof doc.machineId === 'string' && doc.machineId !== '') return doc.machineId;
  } catch {
    /* 首次登录，还没有身份文件 */
  }
  const machineId = crypto.randomUUID();
  try {
    writeFileAtomic(IDENTITY_PATH, `${JSON.stringify({ machineId }, null, 2)}\n`);
  } catch {
    /* 写不进就本次用临时值，下次登录会重新生成——不影响登录本身 */
  }
  return machineId;
}

/** UMID 设备指纹 token，现在固定返回空串：来源是阿里 UMID 组件（要跑过 CLI 才有缓存）， CLI 移除后没了。**不传是官方支持的降级路径**（`startDeviceFlow` 里为空就不设该参数，实测设备流登录完全不需要它）。
 * 保留函数只为 `buildAuthorizeUrl` 的可选参数； **不要**再去读 CLI 的缓存文件。 */
export function loadUmidMachineToken(): string {
  return '';
}

/** 生成 PKCE 对：verifier 用 base64url（无填充），challenge = sha256(verifier) 再 base64url。 */
export function pkceChallenge(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** 拼授权 URL。`machine_id` / `nonce` / `challenge` / `client_id` 都进 query，
 *  有 UMID machine_token 时也带上（官方 `startDeviceFlow` 的 `n` 参数）。 */
export function buildAuthorizeUrl(input: { challenge: string; nonce: string; machineId: string; machineToken?: string }): string {
  const params = new URLSearchParams({
    challenge: input.challenge,
    challenge_method: 'S256',
    nonce: input.nonce,
    machine_id: input.machineId,
    client_id: CLIENT_ID,
  });
  if (input.machineToken && input.machineToken.trim() !== '') {
    params.set('machine_token', input.machineToken);
  }
  return `${WEB_BASE}${AUTH_PATH}?${params.toString()}`;
}

/** 拼轮询 URL。只带 nonce + verifier + challenge_method。 */
export function buildPollUrl(input: { nonce: string; verifier: string }): string {
  const params = new URLSearchParams({
    nonce: input.nonce,
    verifier: input.verifier,
    challenge_method: 'S256',
  });
  return `${OPENAPI_BASE}${POLL_PATH}?${params.toString()}`;
}

export interface DeviceFlowResult {
  /** `dt-` 会话令牌，只给 `/sash/*` 用。 */
  token: string;
  /** `drt-` 刷新令牌，给 `deviceToken/refresh` 用。 */
  refreshToken: string;
  /** ISO 时间串。 */
  expiresAt: string;
  /** ISO 时间串。 */
  refreshTokenExpiresAt: string;
  /** 上游用户 id（能拿到就带，拿不到为空）。 */
  userId: string;
  /** 上游昵称（能拿到就带）。 */
  username: string;
}

/** 从 poll 的成功响应里归一化出设备流结果。**poll 和 refresh 两个接口字段名不一样**： poll 返回 `token`（短字段）、refresh 返回 `device_token`（长字段），所以两个都认；
 * `expires_at` 之外也认 `expires_in`（秒数）。 */
export function parsePollResponse(doc: any): DeviceFlowResult | null {
  if (!doc || typeof doc !== 'object') return null;
  const token = typeof doc.token === 'string' ? doc.token : typeof doc.device_token === 'string' ? doc.device_token : '';
  if (token === '') return null;

  const refreshToken = typeof doc.refresh_token === 'string' ? doc.refresh_token : '';
  const expiresAt = toIso(doc.expires_at, doc.expires_in);
  const refreshTokenExpiresAt = toIso(doc.refresh_token_expires_at, doc.refresh_token_expires_in);

  return {
    token,
    refreshToken,
    expiresAt,
    refreshTokenExpiresAt,
    userId: typeof doc.user_id === 'string' ? doc.user_id : '',
    username: typeof doc.user_name === 'string' ? doc.user_name : '',
  };
}

/** 把 ISO 串或秒数统一成 ISO 串；都没有返回空串。 */
function toIso(isoValue: unknown, secondsValue: unknown): string {
  if (typeof isoValue === 'string' && isoValue !== '') return isoValue;
  const seconds = Number(secondsValue);
  if (Number.isFinite(seconds) && seconds > 0) return new Date(Date.now() + seconds * 1000).toISOString();
  return '';
}

/** 跑一次设备流登录，成功后返回 `dt-`/`drt-`：生成 PKCE + nonce + 复用 machine_id → `onUrl(authUrl)` 交给前端 → 轮询 poll 直到成功/超时/取消。
 * **不落盘、不开浏览器**：凭据交给账号层，开浏览器是调用方（面板）的事。 */
export async function runDeviceFlow(
  options: { onUrl?: (url: string) => void; signal?: AbortSignal } = {},
): Promise<DeviceFlowResult> {
  const { verifier, challenge } = pkceChallenge();
  const nonce = crypto.randomUUID();
  const machineId = loadOrCreateMachineId();
  const machineToken = loadUmidMachineToken();

  const authUrl = buildAuthorizeUrl({ challenge, nonce, machineId, machineToken });
  const pollUrl = buildPollUrl({ nonce, verifier });

  options.onUrl?.(authUrl);

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new Error('登录已取消');

    let response: Response;
    try {
      response = await fetch(pollUrl, {
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        signal: options.signal,
      });
    } catch (error: any) {
      if (options.signal?.aborted) throw new Error('登录已取消');
      throw new Error(`轮询设备流失败：${error?.message || error}`);
    }

    if (response.status === 404) {
      // 404 = 还没授权，睡 1 秒继续（取消在下一轮循环开头检查）。
      await sleep(POLL_INTERVAL_MS, options.signal);
      continue;
    }

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`设备流轮询 HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    let doc: any;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new Error(`设备流轮询返回的不是 JSON：${text.slice(0, 200)}`);
    }
    const result = parsePollResponse(doc);
    if (result) return result;
    throw new Error(`设备流轮询 200 但没拿到 token：${text.slice(0, 200)}`);
  }

  throw new Error('设备流登录超时（5 分钟）');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('登录已取消'));
      return;
    }
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

/** 用 `dt-` 拿上游用户信息（昵称 / 邮箱）。设备流 poll 只给 `user_id`、**不给昵称**，所以登录成功后补一发 `GET /api/v1/userinfo` 拿 `name`，账号 label 才不会是「账号1」。
 * **失败不抛错**：昵称只用于展示，不值得为它把一次成功的登录搞失败。 */
export async function fetchUserInfo(token: string): Promise<{ userId: string; username: string } | null> {
  try {
    const response = await fetch(`${OPENAPI_BASE}/api/v1/userinfo`, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return null;
    const doc: any = await response.json();
    if (!doc || typeof doc !== 'object') return null;
    const pick = (...keys: string[]) => {
      for (const key of keys) {
        const value = doc[key];
        if (typeof value === 'string' && value !== '') return value;
      }
      return '';
    };
    return {
      userId: pick('id', 'user_id', 'uid'),
      username: pick('name', 'username', 'user_name'),
    };
  } catch {
    return null;
  }
}

/**
 * 设备流登录入口：全程纯网络，不依赖 DPAPI / APPDATA（这是「容器里登 Qoder」的路径）。
 * 一次授权就够：`dt-` 既能打 `/sash/*`（额度 + 签到），也能现算 COSY 签名（对话）。
 * @param options.onUrl 拿到授权 URL 时回调一次，让前端展示/打开浏览器。
 * @param options.signal 取消信号，用户再点一次登录时掐掉上一次。
 */
export async function deviceFlowLogin(
  options: { onUrl?: (url: string) => void; signal?: AbortSignal } = {},
): Promise<LoginResult> {
  const flow = await runDeviceFlow(options);
  // poll 只给 user_id、不给昵称，补一发 userinfo 拿 name（失败返回 null，不挡登录）。
  const userInfo = await fetchUserInfo(flow.token);
  const userId = userInfo?.userId || flow.userId;
  const username = userInfo?.username || flow.username;

  // 现算 COSY 签名要用的 userInfo（取代了「让 CLI 登录一次」）。算失败不拦登录——
  // 额度和签到还能用，只是对话会报错，比整条登录失败好。
  let signatureUserInfo: QoderCredential['userInfo'];
  if (userId) {
    try {
      signatureUserInfo = await deriveRuntimeFields({ uid: userId, token: flow.token, dataPolicyAgreed: true });
    } catch {
      signatureUserInfo = undefined;
    }
  }

  const credential: QoderCredential = {
    token: flow.token,
    refreshToken: flow.refreshToken,
    expiresAt: flow.expiresAt,
    refreshTokenExpiresAt: flow.refreshTokenExpiresAt,
    userId,
    username,
    ...(signatureUserInfo ? { userInfo: signatureUserInfo } : {}),
    dataPolicyAgreed: true,
    source: 'device-flow',
    savedAt: Date.now(),
  };
  return {
    credential,
    profile: {
      uid: userId,
      username,
    },
    label: username,
  };
}
