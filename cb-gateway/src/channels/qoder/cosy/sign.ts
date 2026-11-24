/**
 * COSY 签名的高层入口：把「凭据 → 已签名请求」收成两条路。
 *
 * ## 为什么单独一个文件
 *
 * 在这之前，「从凭据拿 userInfo、构造 QoderContext、取签名结果」这段逻辑
 * 在三个地方各写了一遍（对话、模型列表、以及签名本身），每处的差别只有
 * 「用 prepareRequest 还是 prepareInferRequest」「authMode 传什么」。
 * 三份实现意味着三份 bug——2026-11-22 修 userInfo 与 token 绑定那个问题时，
 * 就差点漏掉其中一处。
 *
 * 现在分成：
 *
 *   | 文件 | 职责 |
 *   |---|---|
 *   | `cosy/index.ts` | 初始化 wasm、暴露底层导出（`QoderContext` 等） |
 *   | `cosy/sign.ts`（本文件） | 凭据 → 已签名请求，以及 `userInfo` 的派生与兜底 |
 *   | `upstream.ts` | 请求翻译、帧解析、流式/非流式 |
 *
 * ## 两个必须小心的地方
 *
 * 1. **`userInfo` 与 `token` 绑定**。`encrypt_user_info` 里编码了 token 和 uid，
 *    上游解密后校验它们（token 与 userInfo 不配对时回 `Login expired`）。
 *    所以 token 一换，`userInfo` 必须重算。
 *
 * 2. **同一个 `userInfo` 可以反复用**。实测连发 3 次全成功，所以登录时算一次
 *    存进凭据是够的，不必每次对话都现算（省掉每次几十毫秒的 wasm 调用）。
 */

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

/** 签好的请求，可以直接发出去。 */
export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** 客户端元数据。各字段含义由上游定义，照着 CLI 的 `Gl()` 抄。 */
const CLIENT_METADATA = JSON.stringify({
  client_type: 'cli',
  business_product: 'qoder',
  business_type: 'agent',
  scene: 'assistant',
});

/** 从 `Account.credential` 里我们能看到的形状。 */
interface CredentialLike {
  token?: string;
  userId?: string;
  dataPolicyAgreed?: boolean;
  userInfo?: SignatureUserInfo;
}

/**
 * 拿这次请求签名要用的 `userInfo`。
 *
 * 优先用凭据里存好的（登录/续期时算过）。没有或残缺就**现场补算**——
 * 这样从 CLI 时代升级过来的老凭据不需要强制重新登录。
 *
 * 「残缺」的判据是 `key` 为空：`Cosy-Key` 是它原样透传的，为空必然签名失败。
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
 * 构造一个 `QoderContext` 并保证它被释放。
 *
 * **`free()` 必须调**：每个 context 在 wasm 堆里占一块，不释放就是内存只增不减。
 * 用 try/finally 包住，异常路径也不漏。
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
 * 签一个**对话**请求。
 *
 * 用 `prepareInferRequest`——它和服务端普通 REST 的签名模式不同
 * （`prepareRequest` 要显式传 `'sign'` / `'auth'`）。混用会被上游拒。
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
 * 签一个**普通 REST** 请求（GET / PUT 这类）。
 *
 * `authMode` 决定用哪套签名材料，目前用到的是 `'auth'`。实测：
 *   - `'auth'` → 模型列表接口可用
 *   - `'sign'` → 服务发现类接口用，未验证过我们的场景
 *
 * 两者不能随手互换，换之前先实测。
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
 * 解密上游返回的加密响应体。
 *
 * `/sash/*` 那类接口会把 JSON 再包一层密文。解不开就原样返回——
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
