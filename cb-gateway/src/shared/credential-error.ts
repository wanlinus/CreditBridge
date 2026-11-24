// 「本地这份凭据已经不能用了」——必须和「上游暂时不通」区分开，两者都表现成 502 但处置相反：
// `permanent: true`（refreshToken 过期/被拒、没有刷新机制）→ 账号标 `invalid`，提示重新登录；
// `permanent: false`（网络断、上游 5xx、响应不是 JSON）→ **不动账号状态**，否则一次抖动就把号封了。
//
// 继承 `UpstreamError` 是为了复用路由层「按 status 决定回什么」。**通道包一层时必须原样透传**
// （用 `asCredentialError`），丢了它账号会永远显示「就绪」而实际刷不出凭据。

import { UpstreamError } from './upstream-error.ts';

export class CredentialError extends UpstreamError {
  permanent: boolean;

  constructor(message: string, options: { permanent: boolean; code?: string }) {
    super(502, message, { code: options.code ?? (options.permanent ? 'credential_expired' : 'credential_unavailable') });
    this.name = 'CredentialError';
    this.permanent = options.permanent;
  }
}

/** 再也刷不出来了：refreshToken 过期/被拒、或这个通道压根没有刷新机制。 */
export function credentialExpired(message: string): CredentialError {
  return new CredentialError(message, { permanent: true });
}

/** 暂时换不到凭据（网络、上游 5xx、响应不是 JSON）：不动账号状态，下次再试。 */
export function credentialUnavailable(message: string): CredentialError {
  return new CredentialError(message, { permanent: false });
}

/** 不依赖 instanceof：跨模块副本时 instanceof 会失效。 */
export function isCredentialError(error: any): error is CredentialError {
  return Boolean(error) && error.name === 'CredentialError' && typeof error.permanent === 'boolean';
}

/** 包装错误时保住 `permanent`。直接 `new UpstreamError(502, msg)` 会把它弄丢。 */
export function asCredentialError(error: any, prefix = ''): CredentialError | null {
  if (!isCredentialError(error)) return null;
  const message = prefix ? `${prefix}：${error.message}` : error.message;
  return new CredentialError(message, { permanent: error.permanent, code: error.code });
}
