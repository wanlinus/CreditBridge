/**
 * COSY 签名器的**真实联网**验证：从 `dt-` 现算签名输入，发一次真对话。
 *
 * ## 这条路径取代了「读 CLI 的 .auth/user」
 *
 *   凭据里的 dt- + uid
 *   → deriveRuntimeFields()  现算 encrypt_user_info + key
 *   → signChatRequest()      签名
 *   → 上游 SSE               收 chat.completion.chunk
 *
 * 全程不碰 `data/cli/`。所以它同时验证「登录可以自实现」这件事。
 *
 * ## 为什么不进 `npm test`
 *
 * 会真的打上游、消耗少量积分，且需要真实登录凭据。
 *
 * ## 凭据从哪来
 *
 * 优先用网关账号库里的 qd-1；没有就用环境变量 `QB_QODER_TOKEN` + `QB_QODER_UID`
 * 手工给。两者都没有就跳过（exit 0）。
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

const cosy = await import('../src/channels/qoder/cosy/index.ts');

// ---- 取凭据 ----
let token = process.env.QB_QODER_TOKEN || '';
let uid = process.env.QB_QODER_UID || '';

if (!token || !uid) {
  // 从网关数据库里读 qd-1 的凭据（不走账号层，避免依赖运行时初始化）
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const dbPath = path.join(import.meta.dirname, '..', 'data', 'gateway.db');
    if (fs.existsSync(dbPath)) {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const row = db.prepare("select credential from account where id = 'qd-1'").get();
      db.close();
      if (row?.credential) {
        const credential = JSON.parse(row.credential);
        token = credential.token || '';
        uid = credential.userId || '';
      }
    }
  } catch {
    /* 读不到就走跳过分支 */
  }
}

if (!token || !uid) {
  console.log('跳过：没有可用的 Qoder 凭据（设 QB_QODER_TOKEN + QB_QODER_UID，或让 qd-1 存在）');
  process.exit(0);
}

console.log('=== 1. 从 dt- 现算签名输入（不读 CLI 文件）===');
const userInfo = await cosy.deriveRuntimeFields({ uid, token, dataPolicyAgreed: true });
console.log('  uid:', userInfo.uid);
console.log('  encrypt_user_info:', userInfo.encrypt_user_info.length, '字节');
console.log('  key:', userInfo.key.length, '字节');

console.log('\n=== 2. 签名 ===');
const machineId = (await import('../src/channels/qoder/login.ts')).loadOrCreateMachineId();
const bodyJson = JSON.stringify({
  model: 'auto',
  stream: true,
  messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
});
const signed = await cosy.signChatRequest(userInfo, bodyJson, 'auto', machineId);
console.log('  url:', signed.url.replace(/^https:\/\/[^/]+/, ''));
console.log('  body:', signed.body.length, '字符（已加密）');
console.log('  Cosy-Key:', (signed.headers['Cosy-Key'] || '').length, '字符');

console.log('\n=== 3. 发请求 ===');
const u = new URL(signed.url);
const headers = {};
for (const [k, v] of Object.entries(signed.headers)) {
  const lk = k.toLowerCase();
  if (['host', 'connection', 'content-length', 'accept-encoding'].includes(lk)) continue;
  if (v === '') continue;
  headers[lk] = v;
}
headers['content-length'] = Buffer.byteLength(signed.body);

const res = await new Promise((resolve) => {
  const req = https.request(
    { hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers, timeout: 60000 },
    (response) => {
      let d = '';
      response.setEncoding('utf8');
      response.on('data', (c) => {
        d += c;
        if (d.length > 8000) req.destroy();
      });
      response.on('end', () => resolve({ status: response.statusCode, data: d }));
      response.on('error', () => resolve({ status: response.statusCode, data: d }));
    },
  );
  req.on('error', (e) => resolve({ error: e.message }));
  req.on('timeout', () => {
    req.destroy();
    resolve({ error: 'timeout' });
  });
  req.end(signed.body);
});

const text = String(res.data || '');
const chunks = (text.match(/chat\.completion\.chunk/g) || []).length;
console.log('  HTTP', res.status);
console.log('  chat.completion.chunk 帧数:', chunks);

if (chunks > 0) {
  console.log('\n✓ 通过：dt- → 现算 → 签名 → 上游接受。登录可自实现，CLI 无需存在。');
  process.exit(0);
}
console.log('\n✗ 失败');
console.log('  响应前 500:', text.slice(0, 500).replace(/\n/g, ' '));
process.exit(1);
