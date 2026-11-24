/** COSY 签名的高层入口：凭据 → 已签名请求。坑一：`encrypt_user_info` 里编码了 token 和 uid，token 一换 `userInfo` 必须重算，不配对时上游只回 `Login expired`。
 * 坑二：同一个 `userInfo` 可以反复用（实测连发 3 次全成功）。 */

import type { Account } from '../../../types.ts';
import { UpstreamError } from '../../../shared/upstream-error.ts';
import { deriveRuntimeFields, getCosyRuntime, COSY_VERSION, DEFAULT_ENDPOINT } from './index.ts';
import { loadOrCreateMachineId } from '../login.ts';

/** 签名要的用户信息。三个字段缺一不可。 */
export interface SignatureUserInfo {
  uid: string;
  encrypt_user_info: string;
  key: string;
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

const CLIENT_METADATA = JSON.stringify({
  client_type: 'cli',
  business_product: 'qoder',
  business_type: 'agent',
  scene: 'assistant',
});

interface CredentialLike {
  token?: string;
  userId?: string;
  dataPolicyAgreed?: boolean;
  userInfo?: SignatureUserInfo;
}

/**
 * 拿这次请求签名要用的 `userInfo`：优先用凭据里存好的（登录/续期时算过），没有或 `key` 为空
 * 就现场补算（`Cosy-Key` 是它原样透传的，为空必然签名失败），这样老凭据不用强制重新登录。
 */
export async function resolveSignatureUserInfo(account: Account): Promise<SignatureUserInfo> {
  const credential = account.credential as CredentialLike | null | undefined;

  if (credential?.userInfo && credential.userInfo.key !== '') return credential.userInfo;

  const uid = credential?.userId ?? '';
  const token = credential?.token ?? '';
  if (uid === '' || token === '') {
    throw new UpstreamError(401, 'Qoder 凭据缺少 userId 或 token，请重新登录', {
      code: 'qoder_missing_credential',
    });
  }
  return await deriveRuntimeFields({ uid, token, dataPolicyAgreed: credential?.dataPolicyAgreed ?? true });
}

/**
 * 构造一个 `QoderContext` 并保证被释放。**`free()` 必须调**：每个 context 在 wasm 堆里占一块，
 * 不释放就是内存只增不减；用 try/finally 包住，异常路径也不漏。
 */
async function withQoderContext<T>(userInfo: SignatureUserInfo, fn: (ctx: any) => T): Promise<T> {
  const rt = await getCosyRuntime();
  const ctx = new rt.QoderContext(
    loadOrCreateMachineId(),
    COSY_VERSION,
    JSON.stringify({
      uid: userInfo.uid,
      encrypt_user_info: userInfo.encrypt_user_info,
      key: userInfo.key,
    }),
    CLIENT_METADATA,
  );
  try {
    return fn(ctx);
  } finally {
    try {
      ctx.free();
    } catch {
      /* 已经释放过就忽略 */
    }
  }
}

/** 把 wasm 的 Headers 对象转成普通对象（空值丢弃——空 `Cosy-Key` 会判签名无效）。 */
function headersToRecord(headers: any): Record<string, string> {
  const record: Record<string, string> = {};
  if (!headers) return record;
  if (typeof headers.forEach === 'function') {
    headers.forEach((value: string, key: string) => {
      record[key] = value;
    });
    return record;
  }
  Object.assign(record, headers);
  return record;
}

/**
 * 签一个**对话**请求。用 `prepareInferRequest`——它和普通 REST 的签名模式不同
 * （`prepareRequest` 要显式传 `'sign'` / `'auth'`），混用会被上游拒。
 */
export async function signChatRequest(
  userInfo: SignatureUserInfo,
  bodyJson: string,
  modelKey: string,
): Promise<SignedRequest> {
  return withQoderContext(userInfo, (ctx) => {
    const result = ctx.prepareInferRequest(DEFAULT_ENDPOINT, bodyJson, modelKey, 'system');
    return { url: result.url, headers: headersToRecord(result.headers), body: result.body };
  });
}

/**
 * 签一个**普通 REST** 请求。`authMode` 决定用哪套签名材料：`'auth'` 实测模型列表可用，
 * `'sign'` 用于服务发现类接口、我们的场景未验证。两者不能随手互换，换之前先实测。
 */
export async function signRestRequest(
  userInfo: SignatureUserInfo,
  pathAndQuery: string,
  method: 'GET' | 'PUT' | 'POST',
  authMode: 'auth' | 'sign' = 'auth',
  body?: string,
  headersJson?: string,
): Promise<SignedRequest> {
  return withQoderContext(userInfo, (ctx) => {
    const result = ctx.prepareRequest(DEFAULT_ENDPOINT, pathAndQuery, method, authMode, body, headersJson);
    return { url: result.url, headers: headersToRecord(result.headers), body: result.body };
  });
}

/**
 * 解密上游返回的加密响应体（`/sash/*` 会把 JSON 再包一层密文）。解不开就原样返回——
 * 大多数接口是明文，硬解会把正常响应搞坏。
 */
export async function decryptServerResponse(payload: string): Promise<string> {
  const rt = await getCosyRuntime();
  try {
    return rt.decryptServerResponse(payload);
  } catch {
    return payload;
  }
}
