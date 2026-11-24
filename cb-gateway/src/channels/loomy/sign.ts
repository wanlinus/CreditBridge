// Loomy（讯飞）账号服务的 HMAC-SHA1 请求签名。
//
// 从客户端 `electron/xfyun/sign.js` 逐行还原（2026-11-11，Loomy 0.9.39）。
// 签名形状是讯飞开放平台的标准 `account <accessKeyId>:<signature>`，待签字符串
// 9 行（`\n` 连接）：
//
//   METHOD
//   ESCAPED_PATH
//   ESCAPED_QUERY_STRING
//   CONTENT_MD5
//   CONTENT_TYPE
//   DATE
//   NONCE
//   SIGNED_HEADERS
//   CANONICALIZED_HEADERS
//
// 登录接口（`/login/phone/sendMsgCode`、`/login/phone/checkCode` 等）都走这套签名，
// 但**对话 / 模型 / 余额不走**——那些在 `loomyad.xunfei.cn/api/v1`，用 session 当
// Bearer 认证，见 `auth.ts`。两者是两个域名、两套认证，别混。

import crypto from 'node:crypto';

/** Content-MD5：对 body 字符串做 MD5 再 base64。空 body 返回空串。 */
function contentMD5(body: string): string {
  if (!body) return '';
  return crypto.createHash('md5').update(body, 'utf8').digest('base64');
}

/** URL Path 段转义（RFC3986 §3.3）。 */
function escapePathSegment(segment: string): string {
  return encodeURIComponent(segment)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

/** URL Query 值转义（RFC3986 §3.4）。 */
function escapeQueryValue(value: string): string {
  return encodeURIComponent(value)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

/** 拼 ESCAPED_PATH：每个段单独转义，首尾斜杠规整。 */
function buildEscapedPath(path: string): string {
  let clean = path.startsWith('/') ? path : `/${path}`;
  if (clean.length > 1 && clean.endsWith('/')) clean = clean.slice(0, -1);
  return clean.split('/').map((seg) => (seg ? escapePathSegment(seg) : '')).join('/');
}

/** 拼 ESCAPED_QUERY_STRING。没有 query 返回空串。 */
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
 * 生成一套账号服务的请求头。
 *
 * 只在登录/账号接口用（`account.xfinfr.com`），不对对话链路生效。`accessKeyId` /
 * `accessKeySecret` 是随客户端 `.env.prod` 分发的应用级密钥（见 `auth.ts` 常量处
 * 的来源说明），不是用户凭据。
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
