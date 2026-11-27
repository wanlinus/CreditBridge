/**
 * 全前端唯一的 HTTP 封装。
 *
 * 只做三件事，多一件都不做（缓存、重试、乐观更新都不在通用层，见 `useAsync.ts` 的理由）：
 *
 *   1. **错误信封解包**：网关的错误是 `{ error: { message, type } }`，抛成 `ApiError`，
 *      让调用方拿到 `type` 而不是去解析字符串。
 *   2. **401 → 跳登录页**：会话是内存态、12 小时过期、容器重启就没了。任何一个请求
 *      撞上 401 都说明「该重新登录」，让每个页面各写一遍是重复。
 *   3. **403 `password_change_required` → 跳改密页**：新部署时 `mustChangePassword`
 *      是 true，不识别这个类型就会在首页看到一堆失败的请求而不明所以。
 *
 * ## 为什么用注册回调跳转，而不是在这里 import router
 *
 * `router/index.ts` 会 import 各个 View，View 会 import api——直接 import router 会绕成
 * 一个环。所以由 `main.ts` 在启动时把跳转函数注册进来，本模块只持有它。
 */

export class ApiError extends Error {
  /** 网关给的错误分类（`unauthorized` / `not_found` / `password_change_required` / …）。 */
  readonly type: string;
  readonly status: number;

  constructor(message: string, type: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.type = type;
    this.status = status;
  }
}

type Navigator = (kind: 'login' | 'password') => void;

let navigate: Navigator | null = null;

/** 由 `main.ts` 注册。放在启动时而不是模块顶层，是为了让 router 先建好。 */
export function setNavigator(fn: Navigator): void {
  navigate = fn;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** 传 `true` 表示不处理 401/403 跳转——登录页自己要用，否则会自己跳自己。 */
  skipAuthRedirect?: boolean;
}

/**
 * 发一个请求并解包 JSON。
 *
 * `credentials: 'same-origin'` 是显式的：会话走 Cookie（`HttpOnly` + `SameSite=Lax`），
 * 同源下默认就会带，写出来是为了让「凭据从哪来」这件事在代码里看得见。
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, skipAuthRedirect = false } = options;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error: any) {
    // 网络层失败（断网、网关没起、请求被取消）。给一个能看懂的 message，
    // 不要把 TypeError: Failed to fetch 直接甩到界面上。
    throw new ApiError(`连不上网关：${error?.message || error}`, 'network_error', 0);
  }

  const text = await response.text();
  let doc: any = null;
  if (text) {
    try {
      doc = JSON.parse(text);
    } catch {
      // 不是 JSON：多半是打到了页面而不是接口（路径写错，或被 SPA fallback 接走了）。
      // 这类错误的原文很有用，截一段带出去。
      throw new ApiError(
        `网关回了非 JSON（HTTP ${response.status}）：${text.slice(0, 160)}`,
        'protocol_error',
        response.status,
      );
    }
  }

  if (response.ok) return doc as T;

  const message = doc?.error?.message || doc?.message || `HTTP ${response.status}`;
  const type = doc?.error?.type || 'http_error';

  if (!skipAuthRedirect) {
    if (response.status === 401) navigate?.('login');
    else if (response.status === 403 && type === 'password_change_required') navigate?.('password');
  }

  throw new ApiError(message, type, response.status);
}

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'PATCH', body }),
  delete: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'DELETE' }),
};
