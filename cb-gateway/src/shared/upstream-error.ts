// 通道转发失败时抛这个。不用裸 Error 是因为**路由层要根据上游状态码改账号状态**——401 标 `invalid`、
// 429 标 `cooldown` 并带恢复时间。让通道自己判断等于把状态机拆成每家一份，而且通道看不到账号。
// 抛错而不是返回 `{ok:false}`：通道内部到处是 `await fetch` + 解析，异常路径天然就是 throw。

/**
 * 上游出的验证题。**只有需要用户做验证时才有**（豆包 verifyCenter）。
 * 有它说明「能点」；为 `null` 说明是硬拒绝，点了也没用。
 */
export interface UpstreamChallenge {
  url: string;
  code: string;
  subtype: string;
  ticket: string;
  event: string;
}

export interface UpstreamErrorOptions {
  /** 机器可读的错误码，进 `error.code`。默认 `upstream_error`。 */
  code?: string;
  /** 上游要求的最早重试时间（毫秒时间戳）。429 时用它定冷却截止点。 */
  retryAt?: number | null;
  /** 上游出的验证题，交给界面渲染。 */
  challenge?: UpstreamChallenge | null;
  /**
   * 二维码过期了，界面该给一个「刷新」按钮。
   *
   * 单独一个标记而不是靠 `code` 判断：过期不是失败，是**中间状态**——
   * 用户点一下刷新就能继续，不该让他重新走一遍登录。
   */
  qrExpired?: boolean;
}

export class UpstreamError extends Error {
  /** 回给客户端的 HTTP 状态码。 */
  status: number;
  code: string;
  retryAt: number | null;
  /** 上游出的验证题，交给界面渲染。 */
  challenge: UpstreamChallenge | null;
  /** 二维码过期了，界面该给「刷新」按钮（不是失败，点一下就能继续）。 */
  qrExpired: boolean;

  constructor(status: number, message: string, options: UpstreamErrorOptions = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.code = options.code || 'upstream_error';
    this.retryAt = options.retryAt ?? null;
    this.challenge = options.challenge ?? null;
    this.qrExpired = options.qrExpired === true;
  }
}

/** 从 `Retry-After` 响应头算恢复时间，支持秒数和 HTTP 日期两种格式（RFC 9110）。解析不出来返回 `null`，由调用方兜底默认冷却时长。 */
export function retryAfterAt(header: string | null | undefined, now = Date.now()): number | null {
  const text = String(header ?? '').trim();
  if (text === '') return null;
  if (/^[0-9]+$/.test(text)) return now + Number(text) * 1000;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}
