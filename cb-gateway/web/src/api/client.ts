export class ApiError extends Error {
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

export function setNavigator(fn: Navigator): void {
  navigate = fn;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  skipAuthRedirect?: boolean;
}

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
    throw new ApiError(`连不上网关：${error?.message || error}`, 'network_error', 0);
  }

  const text = await response.text();
  let doc: any = null;
  if (text) {
    try {
      doc = JSON.parse(text);
    } catch {
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
