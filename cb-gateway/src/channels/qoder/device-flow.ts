import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR, STATE_DIR } from '../../shared/paths.ts';
import { writeFileAtomic } from '../../shared/atomic-write.ts';

const WEB_BASE = 'https://qoder.cn';
const OPENAPI_BASE = 'https://openapi.qoder.com.cn';
const AUTH_PATH = '/device/selectAccounts';
const POLL_PATH = '/api/v1/deviceToken/poll';

const CLIENT_ID = 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb';

const USER_AGENT = 'qoder/1.1.79-hotfix.19';

const POLL_INTERVAL_MS = 1000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const IDENTITY_PATH = path.join(STATE_DIR, 'qoder-identity.json');

export function loadOrCreateMachineId(): string {
  try {
    const doc = JSON.parse(fs.readFileSync(IDENTITY_PATH, 'utf8'));
    if (typeof doc.machineId === 'string' && doc.machineId !== '') return doc.machineId;
  } catch {
  }
  const machineId = crypto.randomUUID();
  try {
    writeFileAtomic(IDENTITY_PATH, `${JSON.stringify({ machineId }, null, 2)}\n`);
  } catch {
  }
  return machineId;
}

export function loadUmidMachineToken(): string {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'cli', 'qoder', 'config', 'umid-cache.json'), 'utf8'));
    const token = doc && doc.info && typeof doc.info.machineToken === 'string' ? doc.info.machineToken : '';
    return token.trim();
  } catch {
    return '';
  }
}

export function pkceChallenge(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

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

export function buildPollUrl(input: { nonce: string; verifier: string }): string {
  const params = new URLSearchParams({
    nonce: input.nonce,
    verifier: input.verifier,
    challenge_method: 'S256',
  });
  return `${OPENAPI_BASE}${POLL_PATH}?${params.toString()}`;
}

export interface DeviceFlowResult {
  token: string;
  refreshToken: string;
  expiresAt: string;
  refreshTokenExpiresAt: string;
  userId: string;
  username: string;
}

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

function toIso(isoValue: unknown, secondsValue: unknown): string {
  if (typeof isoValue === 'string' && isoValue !== '') return isoValue;
  const seconds = Number(secondsValue);
  if (Number.isFinite(seconds) && seconds > 0) return new Date(Date.now() + seconds * 1000).toISOString();
  return '';
}

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
