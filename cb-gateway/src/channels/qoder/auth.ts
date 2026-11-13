import type { LoginResult } from '../../types.ts';
import { credentialExpired, credentialUnavailable } from '../../shared/credential-error.ts';
import { fetchUserInfo, loadOrCreateMachineId, loadUmidMachineToken, runDeviceFlow } from './device-flow.ts';

export interface QoderCredential {
  token: string;
  refreshToken?: string;
  expiresAt?: string;
  refreshTokenExpiresAt?: string;
  userId?: string;
  username?: string;
  source: string;
  savedAt: number;
}

function refreshTokenDead(credential: QoderCredential): boolean {
  if (!credential.refreshTokenExpiresAt) return false;
  const at = Date.parse(credential.refreshTokenExpiresAt);
  if (!Number.isFinite(at)) return false;
  return at - Date.now() < 60 * 1000;
}

const REFRESH_URL = 'https://openapi.qoder.com.cn/api/v1/deviceToken/refresh';

export async function refreshQoderCredential(credential: QoderCredential): Promise<QoderCredential> {
  if (!credential.refreshToken) throw credentialExpired('凭据里没有 refreshToken，无法续期');
  if (refreshTokenDead(credential)) throw credentialExpired('refreshToken 已过期，需要在客户端重新登录');

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

  return {
    ...credential,
    token: doc.device_token,
    refreshToken: doc.refresh_token || credential.refreshToken,
    expiresAt: doc.expires_at || credential.expiresAt,
    refreshTokenExpiresAt: doc.refresh_token_expires_at || credential.refreshTokenExpiresAt,
    source: 'refresh',
    savedAt: Date.now(),
  };
}

export async function deviceFlowLogin(
  options: { onUrl?: (url: string) => void; signal?: AbortSignal } = {},
): Promise<LoginResult> {
  const flow = await runDeviceFlow(options);
  const userInfo = await fetchUserInfo(flow.token);
  const userId = userInfo?.userId || flow.userId;
  const username = userInfo?.username || flow.username;
  const credential: QoderCredential = {
    token: flow.token,
    refreshToken: flow.refreshToken,
    expiresAt: flow.expiresAt,
    refreshTokenExpiresAt: flow.refreshTokenExpiresAt,
    userId,
    username,
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
