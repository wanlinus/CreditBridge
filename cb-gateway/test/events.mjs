import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-events-'));
process.env.QB_DATA_DIR = tempData;
process.env.QB_TRAE_LOGIN_HOST = '0.0.0.0';
process.env.QB_TRAE_LOGIN_PORT = '18801';
process.env.QB_TRAE_CALLBACK_BASE = 'http://127.0.0.1:18801';

fs.mkdirSync(path.join(tempData, 'auth'), { recursive: true });
fs.writeFileSync(path.join(tempData, 'config.json'), JSON.stringify({ host: '127.0.0.1', port: 7898, verbose: false }, null, 2));

const events = await import('../src/core/events.ts');
const traeLogin = await import('../src/channels/trae/login.ts');
const auth = await import('../src/shared/gateway-auth.ts');
const keys = await import('../src/core/keys.ts');

let pass = 0;
let fail = 0;
function check(name, actual, expected = true) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}\n      期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

console.log('--- 1. 事件总线 ---');
events.resetEventBusForTests();
check('初始没有订阅者', events.subscriberCount(), 0);

const seen = [];
const unsubscribe = events.subscribeEvents((event) => seen.push(event));
check('订阅后有 1 个订阅者', events.subscriberCount(), 1);
check('广播送达 1 个', events.publishEvent({ type: 'login', state: 'running' }), 1);
check('订阅者收到了', seen, [{ type: 'login', state: 'running' }]);

const seen2 = [];
events.subscribeEvents((event) => seen2.push(event));
check('两个订阅者都收到', events.publishEvent({ type: 'x' }), 2);
check('第二个订阅者也有', seen2.length, 1);

events.resetEventBusForTests();
const good = [];
events.subscribeEvents(() => {
  throw new Error('坏掉的订阅者');
});
events.subscribeEvents((event) => good.push(event));
check('坏订阅者抛错后好订阅者仍收到', events.publishEvent({ type: 'y' }), 1);
check('好订阅者确实收到了', good.length, 1);

events.resetEventBusForTests();
const seen3 = [];
const off = events.subscribeEvents((event) => seen3.push(event));
off();
check('退订后订阅者清零', events.subscriberCount(), 0);
events.publishEvent({ type: 'z' });
check('退订后收不到', seen3.length, 0);

console.log('\n--- 2. Trae 环回判定（loginLoopback）---');
check('环回 + 固定端口 → 报端口', traeLogin.loginLoopback(), { port: 18801, path: '/authorize' });

process.env.QB_TRAE_CALLBACK_BASE = 'http://10.0.0.45:18801';
check('回调是内网 IP → 不需要转发（null）', traeLogin.loginLoopback(), null);

process.env.QB_TRAE_CALLBACK_BASE = 'https://gateway.example.com';
check('回调是公网域名 → 不需要转发（null）', traeLogin.loginLoopback(), null);

process.env.QB_TRAE_LOGIN_PORT = '0';
process.env.QB_TRAE_CALLBACK_BASE = 'http://127.0.0.1:0';
check('随机端口（0）→ 报 null（外部没法预告）', traeLogin.loginLoopback(), null);

process.env.QB_TRAE_LOGIN_PORT = '18801';
process.env.QB_TRAE_CALLBACK_BASE = 'http://127.0.0.1:18801';

console.log('\n--- 3. SSE 端点 ---');
auth.loadCredential();
auth.changePassword('admin', 'probe-123456');
const { secret } = keys.createKey('SSE 测试');

const { createApp } = await import('../src/app.ts');
const app = createApp();
const authed = { Authorization: `Bearer ${secret}` };

check('没凭据 → 401', (await app.request('/api/events')).status, 401);

const response = await app.request('/api/events', { headers: authed });
check('带凭据 → 200', response.status, 200);
check('Content-Type 是 event-stream', (response.headers.get('content-type') || '').includes('text/event-stream'), true);

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

async function readUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(buffer)) return buffer;
    const next = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 200)),
    ]);
    if (next && next.timeout) continue;
    if (!next || next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
  }
  return buffer;
}

const handshake = await readUntil((text) => text.includes(': connected'));
check('收到握手注释', handshake.includes(': connected'), true);

events.publishEvent({ type: 'login', channelId: 'trae', taskId: 't-1', state: 'running', loopback: { port: 18801, path: '/authorize' } });
const got = await readUntil((text) => text.includes('event: login'));
check('事件帧发出去了', got.includes('event: login'), true);
check('帧里带 data 行', /data: \{"type":"login"/u.test(got), true);
check('data 是合法 JSON 且字段完整', (() => {
  const line = got.split('\n').find((l) => l.startsWith('data: '));
  if (!line) return false;
  const doc = JSON.parse(line.slice(6));
  return doc.channelId === 'trae' && doc.loopback.port === 18801 && doc.state === 'running';
})(), true);

await reader.cancel();
await new Promise((resolve) => setTimeout(resolve, 60));
check('断开后订阅者归零', events.subscriberCount(), 0);

fs.rmSync(tempData, { recursive: true, force: true });
console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
