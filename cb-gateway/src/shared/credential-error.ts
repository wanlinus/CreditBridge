import { UpstreamError } from './upstream-error.ts';

export class CredentialError extends UpstreamError {
  permanent: boolean;

  constructor(message: string, options: { permanent: boolean; code?: string }) {
    super(502, message, { code: options.code ?? (options.permanent ? 'credential_expired' : 'credential_unavailable') });
    this.name = 'CredentialError';
    this.permanent = options.permanent;
  }
}

export function credentialExpired(message: string): CredentialError {
  return new CredentialError(message, { permanent: true });
}

export function credentialUnavailable(message: string): CredentialError {
  return new CredentialError(message, { permanent: false });
}

export function isCredentialError(error: any): error is CredentialError {
  return Boolean(error) && error.name === 'CredentialError' && typeof error.permanent === 'boolean';
}

export function asCredentialError(error: any, prefix = ''): CredentialError | null {
  if (!isCredentialError(error)) return null;
  const message = prefix ? `${prefix}：${error.message}` : error.message;
  return new CredentialError(message, { permanent: error.permanent, code: error.code });
}
