import crypto from 'node:crypto';

function contentMD5(body: string): string {
  if (!body) return '';
  return crypto.createHash('md5').update(body, 'utf8').digest('base64');
}

function escapePathSegment(segment: string): string {
  return encodeURIComponent(segment)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

function escapeQueryValue(value: string): string {
  return encodeURIComponent(value)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

function buildEscapedPath(path: string): string {
  let clean = path.startsWith('/') ? path : `/${path}`;
  if (clean.length > 1 && clean.endsWith('/')) clean = clean.slice(0, -1);
  return clean.split('/').map((seg) => (seg ? escapePathSegment(seg) : '')).join('/');
}

function buildEscapedQueryString(queryParams: Record<string, unknown>): string {
  const entries = Object.entries(queryParams || {});
  if (entries.length === 0) return '';
  return entries
    .map(([key, value]) => {
      const escapedKey = escapeQueryValue(key);
      const escapedValue = value !== null && value !== undefined ? escapeQueryValue(String(value)) : '';
      return `${escapedKey}=${escapedValue}`;
    })
    .join('&');
}

export function generateAccountHeaders(options: {
  accessKeyId: string;
  accessKeySecret: string;
  method: string;
  path: string;
  queryParams?: Record<string, unknown>;
  body: string;
  contentType?: string;
}): Record<string, string> {
  const { accessKeyId, accessKeySecret, method, path, queryParams = {}, body } = options;
  const contentType = options.contentType ?? 'application/json';
  const date = new Date().toUTCString();
  const nonce = crypto.randomUUID();

  const md5 = contentMD5(body);
  const signedHeaders = '';
  const canonicalizedHeaders = '';

  const parts = [
    method.toUpperCase(),
    buildEscapedPath(path),
    buildEscapedQueryString(queryParams),
    md5,
    contentType,
    date,
    nonce,
    signedHeaders,
    canonicalizedHeaders,
  ];
  const stringToSign = parts.join('\n');
  const signature = crypto.createHmac('sha1', accessKeySecret).update(stringToSign, 'utf8').digest('base64');

  const headers: Record<string, string> = {
    Authorization: `account ${accessKeyId}:${signature}`,
    Date: date,
    Nonce: nonce,
    'Content-Type': contentType,
  };
  if (md5) headers['Content-MD5'] = md5;
  return headers;
}
