// Loomy 签名算法的自测：用固定输入手算 HMAC-SHA1 比对，确认 `sign.ts` 的
// 待签字符串拼接和客户端 `sign.js` 一致。不依赖网络。
//
// 运行：node test/loomy-sign.mjs

import crypto from 'node:crypto';
import { generateAccountHeaders } from '../src/channels/loomy/sign.ts';

let passed = 0;
let failed = 0;
function ok(name, cond) {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}`);
  }
}

// 固定 Date/nonce 不可行（代码内部 new Date / randomUUID），所以这里验证**结构**：
// 1. Authorization 是 `account <id>:<base64>` 且签名能验
// 2. Content-MD5 正确
// 3. Date 是 UTC 格式
// 4. Nonce 是 UUID
const headers = generateAccountHeaders({
  accessKeyId: 'test-key',
  accessKeySecret: 'test-secret',
  method: 'POST',
  path: '/login/phone/sendMsgCode',
  body: JSON.stringify({ base: { appid: 'X' }, param: { phone: '13800138000' } }),
});

ok('Authorization 前缀是 account', headers.Authorization.startsWith('account '));
const authParts = headers.Authorization.slice('account '.length).split(':');
ok('Authorization 有两段（id:签名）', authParts.length === 2);
ok('Authorization 第一段是 accessKeyId', authParts[0] === 'test-key');
ok('签名是合法 base64', /^[A-Za-z0-9+/]+={0,2}$/.test(authParts[1]));

// Content-MD5 手算比对
const body = JSON.stringify({ base: { appid: 'X' }, param: { phone: '13800138000' } });
const md5 = crypto.createHash('md5').update(body, 'utf8').digest('base64');
ok('Content-MD5 正确', headers['Content-MD5'] === md5);

// Date 是 toUTCString 格式（GMT 结尾）
ok('Date 是 GMT 格式', /GMT$/.test(headers.Date));
ok('Nonce 是 UUID', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(headers.Nonce));
ok('Content-Type 是 application/json', headers['Content-Type'] === 'application/json');

// 重新按 client sign.js 的算法手算签名，比对 Authorization 里的签名是否一致。
// 因为 Date/Nonce 已从 headers 里拿到，所以能完整复算。
function clientSign(secret, method, path, query, md5, contentType, date, nonce) {
  const escSeg = (s) => encodeURIComponent(s).replace(/!/g, '%21').replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\*/g, '%2A');
  const escPath = path.startsWith('/') ? path : '/' + path;
  const escapedPath = escPath.split('/').map((s) => (s ? escSeg(s) : '')).join('/');
  const parts = [method, escapedPath, query, md5, contentType, date, nonce, '', ''];
  return crypto.createHmac('sha1', secret).update(parts.join('\n'), 'utf8').digest('base64');
}
const recomputed = clientSign('test-secret', 'POST', '/login/phone/sendMsgCode', '', md5, 'application/json', headers.Date, headers.Nonce);
ok('签名与 client sign.js 手算一致', authParts[1] === recomputed);

// 空 body 不该有 Content-MD5
const noBody = generateAccountHeaders({ accessKeyId: 'a', accessKeySecret: 'b', method: 'POST', path: '/x', body: '' });
ok('空 body 不带 Content-MD5', !('Content-MD5' in noBody));

console.log(`\n${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
