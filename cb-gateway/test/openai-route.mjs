// 守护路由边界：/v1/* 只认 Bearer 不认 Cookie，401 只标 invalid 不换号、429 原样转发不污染状态。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, section, done } from './_helpers.mjs';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-v2-routes-'));
process.env.QB_DATA_DIR = tempData;

const auth = await import('../src/shared/gateway-auth.ts');
const keys = await import('../src/core/keys.ts');
const accounts = await import('../src/core/accounts.ts');
const { channels } = await import('../src/channels/index.ts');
const { createApp } = await import('../src/app.ts');

auth.loadCredential();
const { secret } = keys.createKey('测试用');
const app = createApp();
const bearer = { authorization: `Bearer ${secret}` };
const chatInit = (body) => ({
  method: 'POST',
  headers: { ...bearer, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

section('1. 认证闸');
check('无凭据 → 401', (await app.request('/v1/models')).status, 401);
check('错 key → 401', (await app.request('/v1/models', { headers: { authorization: 'Bearer nope' } })).status, 401);
// 伪造 key 必须和真的不同：直接拼 x 会在 secret 以 x 结尾时拼出同一串，按末位挑不同字符。
const forgedSecret = secret.slice(0, -1) + (secret.endsWith('x') ? 'y' : 'x');
check('前缀对但内容错 → 401', (await app.request('/v1/models', { headers: { authorization: `Bearer ${forgedSecret}` } })).status, 401);
check('没改密码 → 403（凭据对也不放行）', (await app.request('/v1/models', { headers: bearer })).status, 403);

section('2. 改密之后放行');
check('改密成功', auth.changePassword('admin', 'probe-123456'), null);
check('Bearer → 200', (await app.request('/v1/models', { headers: bearer })).status, 200);

section('2b. /v1 只认 Bearer，不认 Cookie');
const sid = auth.createSession();
const cookie = { cookie: `gw_session=${sid}` };
check('/v1/models 带 Cookie → 401', (await app.request('/v1/models', { headers: cookie })).status, 401);
check('/v1/chat/completions 带 Cookie → 401', (await app.request('/v1/chat/completions', { method: 'POST', headers: { ...cookie, 'content-type': 'application/json' }, body: '{}' })).status, 401);
check('/api/health 带 Cookie → 200（管理台要靠它）', (await app.request('/api/health', { headers: cookie })).status, 200);
check('/accounts 页面带 Cookie → 200', (await app.request('/accounts', { headers: cookie })).status, 200);
check('/v1/models 带 Bearer 仍然 200', (await app.request('/v1/models', { headers: bearer })).status, 200);
check('Cookie + Bearer 同时带 → 200（Bearer 优先）', (await app.request('/v1/models', { headers: { ...bearer, ...cookie } })).status, 200);

section('3. 空注册表 / 空账号池');
const saved = channels.splice(0, channels.length);
check('空注册表 + 空账号池 → 空列表', await (await app.request('/v1/models', { headers: bearer })).json(), { object: 'list', data: [] });

section('4. 账号 × 模型');
accounts.loadAccounts();
const fake = {
  id: 'wb',
  idPrefix: 'wb',
  label: 'WorkBuddy',
  identity: { clientVersion: '1.0.0' },
  modelsOf: async () => [{ id: 'hy4free', name: 'Hy4 · 0.00x', context_length: 1000, max_output_tokens: 100 }],
  creditsOf: async () => ({ provider: 'wb', supported: true, totalRemain: 5 }),
  chatAs: async () => ({ kind: 'json', status: 200, body: { ok: true } }),
};
channels.push(fake);
check('没账号时不列模型', (await (await app.request('/v1/models', { headers: bearer })).json()).data.length, 0);

const first = accounts.addAccount({ channelId: 'wb', idPrefix: 'wb', credential: { token: 'a' } });
const second = accounts.addAccount({ channelId: 'wb', idPrefix: 'wb', credential: { token: 'b' }, label: '二号' });
check('账号序号只增不减', [first.id, second.id], ['wb-1', 'wb-2']);

const two = await (await app.request('/v1/models', { headers: bearer })).json();
check('两个账号各一套 id', two.data.map((m) => m.id), ['wb-1/hy4free', 'wb-2/hy4free']);
check('显示名带账号 id 前缀 + 倍率', two.data[0].name, 'wb-1/Hy4 · 0.00x');
check('第二个账号用自己的 id 前缀', two.data[1].name, 'wb-2/Hy4 · 0.00x');
check('owned_by 是通道 id', two.data[0].owned_by, 'wb');
check('带 accountStatus 给管理台', two.data[0].accountStatus, 'ready');

fake.modelsOf = async () => {
  throw new Error('未登录');
};
check('取不到目录的账号被跳过，不 500', (await (await app.request('/v1/models', { headers: bearer })).json()).data.length, 0);
fake.modelsOf = async () => [{ id: 'hy4free', name: 'Hy4 · 0.00x' }];

section('5. 未知路径不猜通道');
check('/v1/nope → 404', (await app.request('/v1/nope', { headers: bearer })).status, 404);
check('旧的通道前缀路由 → 404', (await app.request('/workbuddy/v1/models', { headers: bearer })).status, 404);

section('6. chat：SSE 分支');
let seenModel = null;
let seenAccount = null;
fake.chatAs = async (account, request) => {
  seenAccount = account.id;
  seenModel = request.body.model;
  request.onUsage?.({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, credit: 0.5 });
  return {
    kind: 'stream',
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    body: (async function* () {
      yield 'data: {"id":"1"}\n\n';
      yield 'data: [DONE]\n\n';
    })(),
  };
};
const chatRes = await app.request('/v1/chat/completions', chatInit({ model: 'wb-2/hy4free', messages: [] }));
const chatText = await chatRes.text();
check('chat → 200', chatRes.status, 200);
check('chat 回 SSE', (chatRes.headers.get('content-type') || '').includes('event-stream'));
check('转发前 model 还原成裸 id', seenModel, 'hy4free');
check('用 id 里指定的那个账号，不换号', seenAccount, 'wb-2');
check('SSE 内容原样透传', chatText.includes('data: [DONE]'));

await new Promise((resolve) => setTimeout(resolve, 50));
const { usageRecent } = await import('../src/store/usage.ts');
const ledgerLine = usageRecent({ provider: 'wb' }, 1).ok.at(-1);
check('账本记了 provider', ledgerLine.provider, 'wb');
check('账本记了 account', ledgerLine.account, 'wb-2');
check('账本记了裸模型 id', ledgerLine.model, 'hy4free');

section('6b. 用量在流末尾才回调');
// WorkBuddy 的 onUsage 在生成器 finally 里调，即流结束后才有值；取消那一刻 usage 还是 null。
// 这个用例让流在最后一帧才回调 usage，然后主动取消，验证账本拿得到数字。
fake.chatAs = async (account, request) => ({
  kind: 'stream',
  status: 200,
  headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
  body: (async function* () {
    try {
      yield 'data: {"id":"2"}\n\n';
      yield 'data: {"id":"2","usage":{}}\n\n';
    } finally {
      request.onUsage?.({ prompt_tokens: 111, completion_tokens: 22, total_tokens: 133, credit: 0.75 });
    }
  })(),
});
const lateRes = await app.request('/v1/chat/completions', chatInit({ model: 'wb-1/hy4free', messages: [] }));
const reader = lateRes.body.getReader();
await reader.read();
await reader.cancel();
await new Promise((resolve) => setTimeout(resolve, 120));
const cancelLine = usageRecent({ account: 'wb-1' }, 1).bad.at(-1);
check('取消也记了账', cancelLine.account, 'wb-1');
check('取消时 usage 是流末尾才回调的，账本仍拿到 token', cancelLine.promptTokens, 111);
check('取消时 credit 不是 null', cancelLine.credit, 0.75);
check('取消的账本行 status 是 499', cancelLine.status, 499);

section('7. chat：非流式 + 上游错误码');
fake.chatAs = async () => ({ kind: 'json', status: 400, body: { error: { message: '上游拒绝' } } });
const jsonRes = await app.request('/v1/chat/completions', chatInit({ model: 'wb-1/hy4free', messages: [] }));
check('非 SSE 分支保留状态码', jsonRes.status, 400);
check('非 SSE 分支保留响应体', (await jsonRes.json()).error.message, '上游拒绝');

section('8. 模型 id 解析失败的分支');
for (const model of ['wb-9/hy4free', 'zz-1/x', 'workbuddy/hy4free']) {
  check(`模型 ${model} → 404`, (await app.request('/v1/chat/completions', chatInit({ model }))).status, 404);
}
const legacy = await (await app.request('/v1/chat/completions', chatInit({ model: 'workbuddy/hy4free' }))).json();
check('旧格式的报错里给出新写法', legacy.error.message.includes('wb-'), true);
check('非法 JSON → 400', (await app.request('/v1/chat/completions', { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: '{oops' })).status, 400);

section('9. 429 原样回给客户端，账号状态不动，且不换号');
// 上游 429 按模型限：网关不记冷却、不换号重试，如实转发（Retry-After 猜不准）。
const { UpstreamError } = await import('../src/shared/upstream-error.ts');
let attempts = 0;
fake.chatAs = async () => {
  attempts += 1;
  throw new UpstreamError(429, '上游限流', { code: 'rate_limited', retryAt: Date.now() + 60000 });
};
const limited = await app.request('/v1/chat/completions', chatInit({ model: 'wb-1/hy4free', messages: [] }));
check('429 → 429', limited.status, 429);
check('只打了一次上游（不换号）', attempts, 1);
check('账号仍是 ready（429 不落到账号状态上）', accounts.getAccount('wb-1').status, 'ready');
check('429 的错误码原样透传', (await limited.json()).error.code, 'rate_limited');

const retried = await app.request('/v1/chat/completions', chatInit({ model: 'wb-1/hy4free', messages: [] }));
check('同一个模型再请求 → 仍然 429', retried.status, 429);
check('网关不拦，确实又打了一次上游', attempts, 2);

fake.chatAs = async () => ({ kind: 'json', status: 200, body: { ok: true } });
check('同账号的另一个模型照常能用', (await app.request('/v1/chat/completions', chatInit({ model: 'wb-1/other', messages: [] }))).status, 200);
check('另一个号仍然可以请求', (await app.request('/v1/chat/completions', chatInit({ model: 'wb-2/hy4free', messages: [] }))).status, 200);

section('10. 401 → invalid，503 提示重新登录');
accounts.markReady('wb-1');
fake.chatAs = async () => {
  throw new UpstreamError(401, 'token 失效', { code: 'unauthorized' });
};
check('401 → 401', (await app.request('/v1/chat/completions', chatInit({ model: 'wb-1/hy4free', messages: [] }))).status, 401);
check('账号被标成 invalid', accounts.getAccount('wb-1').status, 'invalid');
const invalidRes = await app.request('/v1/chat/completions', chatInit({ model: 'wb-1/hy4free', messages: [] }));
check('失效的账号 → 503', invalidRes.status, 503);
check('失效提示里让去管理台重新登录', (await invalidRes.json()).error.message.includes('重新登录'), true);

section('11. 停用的账号');
accounts.markReady('wb-1');
accounts.setStatus('wb-1', 'disabled');
check('停用的账号 → 503', (await app.request('/v1/chat/completions', chatInit({ model: 'wb-1/hy4free', messages: [] }))).status, 503);

section('12. 删账号后模型消失');
accounts.removeAccount('wb-2');
const afterDelete = await (await app.request('/v1/models', { headers: bearer })).json();
check('删掉的账号不再出现在模型列表', afterDelete.data.map((m) => m.id), ['wb-1/hy4free']);
check('序号不回收：新账号是 wb-3', accounts.addAccount({ channelId: 'wb', idPrefix: 'wb', credential: {} }).id, 'wb-3');

channels.splice(0, channels.length, ...saved);
const { closeDb } = await import('../src/shared/db.ts');
closeDb();
fs.rmSync(tempData, { recursive: true, force: true });
done();
