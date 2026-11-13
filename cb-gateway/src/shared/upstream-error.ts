export interface UpstreamErrorOptions {
  code?: string;
  retryAt?: number | null;
}

export class UpstreamError extends Error {
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

export function retryAfterAt(header: string | null | undefined, now = Date.now()): number | null {
  const text = String(header ?? '').trim();
  if (text === '') return null;
  if (/^[0-9]+$/.test(text)) return now + Number(text) * 1000;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}
