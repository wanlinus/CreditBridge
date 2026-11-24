// 通道转发失败时抛这个。
//
// 为什么不用裸 Error：**路由层要根据上游状态码改账号状态**——401 说明凭据坏了
// （标 `invalid`），429 说明限流（标 `cooldown` 并带上恢复时间）。让通道自己判断
// 「该不该改状态」等于把状态机拆成三份（每家一份），而且通道根本看不到账号文件。
//
// 抛错而不是返回 `{ok:false}`：通道内部到处是 `await fetch` + 解析，异常路径天然
// 就是 throw；包成返回值要把每一层都改成判空。

export interface UpstreamErrorOptions {
  /** 机器可读的错误码，进 `error.code`。默认 `upstream_error`。 */
  code?: string;
  /** 上游要求的最早重试时间（毫秒时间戳）。429 时用它定冷却截止点。 */
  retryAt?: number | null;
}

export class UpstreamError extends Error {
  /** 回给客户端的 HTTP 状态码。 */
  status: number;
  code: string;
  retryAt: number | null;

  constructor(status: number, message: string, options: UpstreamErrorOptions = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.code = options.code || 'upstream_error';
    this.retryAt = options.retryAt ?? null;
  }
}

/**
 * 从 `Retry-After` 响应头算恢复时间。
 *
 * 支持两种格式（RFC 9110）：秒数（`120`）和 HTTP 日期。解析不出来返回 `null`，
 * 由调用方兜底一个默认冷却时长——宁可控错一会儿，也别把一个限流中的号当成好的。
 */
export function retryAfterAt(header: string | null | undefined, now = Date.now()): number | null {
  const text = String(header ?? '').trim();
  if (text === '') return null;
  if (/^[0-9]+$/.test(text)) return now + Number(text) * 1000;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}
