// Qoder 通道的凭据：`dt-`/`drt-` 会话令牌的获取与续期。
// 反直觉：`dt-` **可以**用于对话——塞进 CLI 的 accessToken payload 会被拒
// （`access_token_invalid`），但那是 CLI 自己的校验，和 COSY 签名是两条路。

import { credentialExpired, credentialUnavailable } from '../../shared/credential-error.ts';
import type { IdentityPatch } from '../../types.ts';
import { loadOrCreateMachineId, loadUmidMachineToken, setQoderVersion } from './login.ts';
import { deriveRuntimeFields } from './cosy/index.ts';

/** 桌面端的更新源（`resources/app-update.yml` 的 `url`，Windows 版是 `static.` 域）。 */
const UPDATE_FEED = 'https://static.qoder.com.cn/qoder-app/releases';

/** 启动时由通道把自述身份注入进来（`login.ts` 的 `QODER_VERSION` 是空串，靠这里填）。 */
export function configureQoderIdentity(clientVersion: string): void {
  setQoderVersion(clientVersion);
}

/** 读 electron-updater 的 `latest.yml` 拿最新版本号。 */
export async function fetchQoderIdentity(): Promise<IdentityPatch> {
  const response = await fetch(`${UPDATE_FEED}/latest.yml`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`版本文件 HTTP ${response.status}`);
  const text = await response.text();
  const match = /^version:\s*(\S+)/m.exec(text);
  if (!match) throw new Error('latest.yml 里没有 version 字段');
  return { clientVersion: match[1] };
}


export interface QoderCredential {
  /** 会话令牌，`dt-` 开头。`/sash/*` 用它，COSY 签名也用它派生 runtime fields。 */
  token: string;
  refreshToken?: string;
  /** ISO 时间串（上游原样存的是这个格式，不是毫秒数）。 */
  expiresAt?: string;
  refreshTokenExpiresAt?: string;
  userId?: string;
  username?: string;
  /**
   * COSY 签名的用户信息，**由 wasm 从 token 现算**（不是服务端下发）。传空会得到空的
   * `Cosy-Key`，上游回内层 403 `Signature invalid`，而**外层 HTTP 仍是 200**。
   */
  userInfo?: {
    uid: string;
    encrypt_user_info: string;
    key: string;
  };
  /** `data_policy_agreed`，现算 runtime fields 时要带，缺了签名会变。 */
  dataPolicyAgreed?: boolean;
  source: string;
  savedAt: number;
}

/** 刷新令牌还剩多久。过期了就只能让用户重新登录客户端。 */
function refreshTokenDead(credential: QoderCredential): boolean {
  if (!credential.refreshTokenExpiresAt) return false;
  const at = Date.parse(credential.refreshTokenExpiresAt);
  if (!Number.isFinite(at)) return false;
  return at - Date.now() < 60 * 1000;
}

const REFRESH_URL = 'https://openapi.qoder.com.cn/api/v1/deviceToken/refresh';

/**
 * 用 `drt-` 换一套新的 `dt-` / `drt-`。两点：**不需要 COSY 签名**（裸 drt- 就能调）；
 * 刷新返回新 drt- 但**旧的不会立刻失效**，所以不做「拿到新的就丢弃旧的」。
 */
export async function refreshQoderCredential(credential: QoderCredential): Promise<QoderCredential> {
  if (!credential.refreshToken) throw credentialExpired('凭据里没有 refreshToken，无法续期');
  if (refreshTokenDead(credential)) throw credentialExpired('refreshToken 已过期，需要在客户端重新登录');

  // 官方 refreshDeviceToken 的 body 是 {refresh_token, machine_id, machine_token}，头带
  // `User-Agent: qoder/<version>`。machine_token 是 UMID 指纹，未就绪时省略（官方同样省略）。
  const body: Record<string, string> = { refresh_token: credential.refreshToken };
  const machineId = loadOrCreateMachineId();
  if (machineId) body.machine_id = machineId;
  const machineToken = loadUmidMachineToken();
  if (machineToken) body.machine_token = machineToken;

  let response;
  try {
    response = await fetch(REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'qoder/1.1.79-hotfix.19' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch (error: any) {
    throw credentialUnavailable(`刷新令牌请求失败：${error.message}`);
  }
  const text = await response.text();
  if (!response.ok) {
    const detail = `刷新令牌失败 HTTP ${response.status}: ${text.slice(0, 200)}`;
    throw response.status >= 400 && response.status < 500 ? credentialExpired(detail) : credentialUnavailable(detail);
  }
  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch {
    throw credentialUnavailable(`刷新接口返回的不是 JSON：${text.slice(0, 200)}`);
  }
  if (!doc.device_token) throw credentialExpired('刷新响应里没有 device_token，请重新登录');

  // **`userInfo` 必须跟着 token 重算**：它和具体那枚 token 绑定，`...credential` 会把旧的
  // userInfo 带过来、而新 token 已换，用它算的签名上游不认。重算失败不拦刷新——额度/签到
  // 用的是 token 本身，对话会走 `resolveSignatureUserInfo()` 的现场补算兜底。
  let refreshedUserInfo = credential.userInfo;
  if (credential.userId) {
    try {
      refreshedUserInfo = await deriveRuntimeFields({
        uid: credential.userId,
        token: doc.device_token,
        dataPolicyAgreed: credential.dataPolicyAgreed ?? true,
      });
    } catch {
      refreshedUserInfo = credential.userInfo;
    }
  }

  return {
    ...credential,
    token: doc.device_token,
    refreshToken: doc.refresh_token || credential.refreshToken,
    expiresAt: doc.expires_at || credential.expiresAt,
    refreshTokenExpiresAt: doc.refresh_token_expires_at || credential.refreshTokenExpiresAt,
    ...(refreshedUserInfo ? { userInfo: refreshedUserInfo } : {}),
    source: 'refresh',
    savedAt: Date.now(),
  };
}

/** 设备流登录在 `login.ts`（`auth` 只负责凭据形状与续期），这里重导出免得调用方改两处。 */
export { deviceFlowLogin } from './login.ts';
