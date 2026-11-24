// Loomy（讯飞）账号服务的 HMAC-SHA1 请求签名，形状是讯飞开放平台的 `account <accessKeyId>:<signature>`，
// 待签字符串 9 行（`\n` 连接，`signedHeaders` / `canonicalizedHeaders` 恒为空串但各占一行）。
// 只给登录/账号接口（`account.xfinfr.com`）用；**对话 / 模型 / 余额不走这套**——那些在
// `loomyad.xunfei.cn/api/v1`，用 session 当 Bearer 认证。

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

/**
 * 生成一套账号服务的请求头。只在登录/账号接口用（`account.xfinfr.com`），不对对话链路生效；
 * `accessKeyId` / `accessKeySecret` 是随客户端 `.env.prod` 分发的应用级密钥，不是用户凭据。
 */
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
  // 登录接口不带自定义 x- 头，所以这两项恒为空串——但算法里它们各占一行。
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
