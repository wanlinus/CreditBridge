// Qoder 通道的凭据：`dt-`/`drt-` 会话令牌的获取与续期。
//
// **一个账号只有一套凭据**：对话需要的 COSY 签名输入是 `{uid, encrypt_user_info, key}`，
// 而 `encrypt_user_info` / `key` **不是服务端下发的**——它们是
// `generate_runtime_auth_fields({uid, security_oauth_token, data_policy_agreed})`
// 用 wasm 本地从 `dt-` 算出来的（见 `cosy/deriveRuntimeFields`）。
//
// 所以登录流程是：设备流拿 `dt-` + `user_id` → `GET /api/v1/userinfo` 补昵称 →
// wasm 现算 `encrypt_user_info` + `key` → 三样一起存进凭据。
//
// **别以为 `dt-` 不能用于对话**：把 `dt-` 塞进 CLI 的 accessToken payload 确实会被拒
// （`access_token_invalid`），但那是 CLI 自己的校验，和 COSY 签名是两条路。

import { credentialExpired, credentialUnavailable } from '../../shared/credential-error.ts';
import { loadOrCreateMachineId, loadUmidMachineToken } from './login.ts';
import { deriveRuntimeFields } from './cosy/index.ts';

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
   * COSY 签名的用户信息，**由 wasm 从 token 现算**（不是服务端下发）。
   *
   * 三个字段缺一不可：`uid` 进签名、`encrypt_user_info` 和 `key` 都参与。
   * 传空会得到空的 `Cosy-Key`，上游回内层 403 `Signature invalid`
   * （外层 HTTP 仍是 200，只看状态码会误判成功）。
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

// ---------------------------------------------------------------- 令牌续期
/** 刷新令牌还剩多久。过期了就只能让用户重新登录客户端。 */
function refreshTokenDead(credential: QoderCredential): boolean {
  if (!credential.refreshTokenExpiresAt) return false;
  const at = Date.parse(credential.refreshTokenExpiresAt);
  if (!Number.isFinite(at)) return false;
  return at - Date.now() < 60 * 1000;
}

const REFRESH_URL = 'https://openapi.qoder.com.cn/api/v1/deviceToken/refresh';

/**
 * 用 `drt-` 换一套新的 `dt-` / `drt-`。
 *
 * `POST {refresh_token: "drt-..."}` → 200
 *
 * ```json
 * {"device_token":"dt-...","refresh_token":"drt-...","token_type":"Bearer",
 *  "expires_at":"2026-12-09T11:56:43Z","refresh_token_expires_at":"2027-11-04T11:56:43Z"}
 * ```
 *
 * 注意两点：
 *   - **不需要 COSY 签名**（和 `/algo/api/v2/model/list` 不同），裸 drt- 就能调；
 *   - 刷新返回新的 drt-，但**旧的不会立刻失效**，所以不做「拿到新的就丢弃旧的」。
 *
 * 有了它，网关就不再依赖 Windows 客户端续期——这是「部署到 Linux/Docker」能长期
 * 成立的前提。
 */
export async function refreshQoderCredential(credential: QoderCredential): Promise<QoderCredential> {
  if (!credential.refreshToken) throw credentialExpired('凭据里没有 refreshToken，无法续期');
  if (refreshTokenDead(credential)) throw credentialExpired('refreshToken 已过期，需要在客户端重新登录');

  // 官方 refreshDeviceToken 的 body 是 {refresh_token, machine_id, machine_token}，
  // 头带 `User-Agent: qoder/<version>`。machine_id 和登录时一致，machine_token 是
  // UMID 指纹（CLI 生成过缓存就有，否则省略——官方同样在 UMID 未就绪时省略）。
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
    // 4xx = refreshToken 被拒（过期/被吊销），5xx = 上游在抖。
    throw response.status >= 400 && response.status < 500 ? credentialExpired(detail) : credentialUnavailable(detail);
  }
  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch {
    throw credentialUnavailable(`刷新接口返回的不是 JSON：${text.slice(0, 200)}`);
  }
  if (!doc.device_token) throw credentialExpired('刷新响应里没有 device_token，请重新登录');

  // **`userInfo` 必须跟着 token 重算**。
  //
  // 它是 `generate_runtime_auth_fields({uid, security_oauth_token, ...})` 的产物，
  // 也就是说**和具体那枚 token 绑定**。`...credential` 会把旧的 userInfo 一起带过来，
  // 而新的 device_token 已经换了——用它算的签名上游不认。
  //
  // 重算失败不拦刷新：额度/签到用的是 token 本身，仍然可用；对话会走
  // `resolveSignatureUserInfo()` 的现场补算兜底。
  let refreshedUserInfo = credential.userInfo;
  if (credential.userId) {
    try {
      refreshedUserInfo = await deriveRuntimeFields({
        uid: credential.userId,
        token: doc.device_token,
        dataPolicyAgreed: credential.dataPolicyAgreed ?? true,
      });
    } catch {
      // 保留旧值：可能仍然可用（上游没校验 token 版本），也可能不行，
      // 但至少不让刷新整体失败。
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

/**
 * 设备流登录搬到了 `login.ts`（和另外三个通道一致：`login` 文件负责整个交互式登录
 * 流程，`auth` 只负责凭据形状与续期）。这里保留重导出，免得调用方改两处。
 */
export { deviceFlowLogin } from './login.ts';
