// v2 路由自测：认证闸、强制改密闸、`/v1/models` 的账号展开、`/v1/chat/completions`
// 的流式/非流式两条分支、以及「账号状态机只改状态、不换号」。
//
// 跑在临时数据目录里（QB_DATA_DIR），不碰真实凭据；**通道换成假实现**，不打任何上游。
//
// 跑：node test/openai-route.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-v2-routes-'));
process.env.QB_DATA_DIR = tempData;

const auth = await import('../src/shared/gateway-auth.ts');
const keys = await import('../src/core/keys.ts');
const accounts = await import('../src/core/accounts.ts');
const { channels } = await import('../src/channels/index.ts');
const { createApp } = await import('../src/app.ts');

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

auth.loadCredential();
// v2 起程序凭据是 API key（`/keys` 页发的），不再有 gateway.json 里的明文 token。
const { secret } = keys.createKey('测试用');
const app = createApp();
const bearer = { authorization: `Bearer ${secret}` };
const chatInit = (body) => ({
  method: 'POST',
  headers: { ...bearer, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// ---- 1. 认证闸 ----
check('无凭据 → 401', (await app.request('/v1/models')).status, 401);
check('错 key → 401', (await app.request('/v1/models', { headers: { authorization: 'Bearer nope' } })).status, 401);
// 伪造的 key 必须**保证**和真的不同：直接拼 `x` 会在 secret 恰好以 `x` 结尾时
// 拼出同一串（1/62 概率，曾经真的红过一次），改成按末位挑一个不同的字符。
const forgedSecret = secret.slice(0, -1) + (secret.endsWith('x') ? 'y' : 'x');
check('前缀对但内容错 → 401', (await app.request('/v1/models', { headers: { authorization: `Bearer ${forgedSecret}` } })).status, 401);
check('没改密码 → 403（凭据对也不放行）', (await app.request('/v1/models', { headers: bearer })).status, 403);

// ---- 2. 改密之后放行 ----
check('改密成功', auth.changePassword('admin', 'probe-123456'), null);
check('Bearer → 200', (await app.request('/v1/models', { headers: bearer })).status, 200);

// ---- 2b. `/v1/*` 只认 Bearer，不认会话 Cookie ----
//
// 这条边界以前只是文档里的一句话：`authGate` 是通配的，两种凭据都认，于是浏览器里
// 登录过的人在地址栏敲 `/v1/models` 也能拿到数据。现在由 `bearerOnlyGate` 收掉。
// 页面和 `/api/*` 必须照旧认 Cookie——那是浏览器打开管理台的唯一方式。
const sid = auth.createSession();
const cookie = { cookie: `gw_session=${sid}` };
check('/v1/models 带 Cookie → 401（不再放行）', (await app.request('/v1/models', { headers: cookie })).status, 401);
check('/v1/chat/completions 带 Cookie → 401', (await app.request('/v1/chat/completions', { method: 'POST', headers: { ...cookie, 'content-type': 'application/json' }, body: '{}' })).status, 401);
check('/api/health 带 Cookie → 200（管理台要靠它）', (await app.request('/api/health', { headers: cookie })).status, 200);
check('/accounts 页面带 Cookie → 200', (await app.request('/accounts', { headers: cookie })).status, 200);
check('/v1/models 带 Bearer 仍然 200', (await app.request('/v1/models', { headers: bearer })).status, 200);
check('Cookie + Bearer 同时带 → 200（Bearer 优先）', (await app.request('/v1/models', { headers: { ...bearer, ...cookie } })).status, 200);

// ---- 3. 空注册表 / 空账号池 ----
const saved = channels.splice(0, channels.length);
check('空注册表 + 空账号池 → 空列表', await (await app.request('/v1/models', { headers: bearer })).json(), {
  object: 'list',
  data: [],
});

// ---- 4. 账号 × 模型：一个号一套 id ----
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
// 显示名只看账号 id，不看 label——label 是给人改的别名，改了不该让 DSH 里的名字跟着变。
check('第二个账号用自己的 id 前缀', two.data[1].name, 'wb-2/Hy4 · 0.00x');
check('owned_by 是通道 id', two.data[0].owned_by, 'wb');
check('带 accountStatus 给管理台', two.data[0].accountStatus, 'ready');

fake.modelsOf = async () => {
  throw new Error('未登录');
};
check('取不到目录的账号被跳过，不 500', (await (await app.request('/v1/models', { headers: bearer })).json()).data.length, 0);
fake.modelsOf = async () => [{ id: 'hy4free', name: 'Hy4 · 0.00x' }];

// ---- 5. 未知路径不猜通道 ----
check('/v1/nope → 404', (await app.request('/v1/nope', { headers: bearer })).status, 404);
check('旧的通道前缀路由 → 404', (await app.request('/workbuddy/v1/models', { headers: bearer })).status, 404);

// ---- 6. chat：SSE 分支 ----
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

// 记账：等一拍，让流的 pull 跑完。
await new Promise((resolve) => setTimeout(resolve, 50));
// v4 B 阶段起账本只在库里（不再写 `usage.jsonl`），所以这里读库。
const { usageRecent } = await import('../src/store/usage.ts');
const ledgerLine = usageRecent({ provider: 'wb' }, 1).ok.at(-1);
check('账本记了 provider', ledgerLine.provider, 'wb');
check('账本记了 account', ledgerLine.account, 'wb-2');
check('账本记了裸模型 id', ledgerLine.model, 'hy4free');

// ---- 6b. 用量在流末尾才回调（真通道的形状）----
//
// WorkBuddy 的 `onUsage` 在生成器的 `finally` 里调，也就是**流结束之后**才有值。
// 早先 `cancel()` 是先 `bookUsage(499)` 再 `iterator.return()`，那一刻 usage 还是
// null，于是账本里 516 行全是 `credit:null`、「今日用量」恒为 0（2026-11-10 用户报的）。
//
// 这个用例让流在**最后一帧**才回调 usage，然后主动取消，验证账本拿得到数字。
const lines = [];
fake.chatAs = async (account, request) => ({
  kind: 'stream',
  status: 200,
  headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
  body: (async function* () {
    try {
      yield 'data: {"id":"2"}\n\n';
      yield 'data: {"id":"2","usage":{}}\n\n';
    } finally {
      // 流收尾时才拿到真实用量——和 WorkBuddy 的行为一致。
      request.onUsage?.({ prompt_tokens: 111, completion_tokens: 22, total_tokens: 133, credit: 0.75 });
    }
  })(),
});
const lateRes = await app.request('/v1/chat/completions', chatInit({ model: 'wb-1/hy4free', messages: [] }));
// 只读一帧就放弃 → 触发 ReadableStream.cancel()
const reader = lateRes.body.getReader();
await reader.read();
await reader.cancel();
await new Promise((resolve) => setTimeout(resolve, 120));
// 取消记的是 499，落在 `bad` 那一批（`ok` 只装 status = 200 的）。
const cancelLine = usageRecent({ account: 'wb-1' }, 1).bad.at(-1);
check('取消也记了账', cancelLine.account, 'wb-1');
check('取消时 usage 是流末尾才回调的，账本仍拿到 token', cancelLine.promptTokens, 111);
check('取消时 credit 不是 null', cancelLine.credit, 0.75);
check('取消的账本行 status 是 499', cancelLine.status, 499);

// ---- 7. chat：非流式 + 上游错误码 ----
fake.chatAs = async () => ({ kind: 'json', status: 400, body: { error: { message: '上游拒绝' } } });
const jsonRes = await app.request('/v1/chat/completions', chatInit({ model: 'wb-1/hy4free', messages: [] }));
check('非 SSE 分支保留状态码', jsonRes.status, 400);
check('非 SSE 分支保留响应体', (await jsonRes.json()).error.message, '上游拒绝');

// ---- 8. 模型 id 解析失败的分支 ----
check('账号不存在 → 404', (await app.request('/v1/chat/completions', chatInit({ model: 'wb-9/hy4free' }))).status, 404);
check('短前缀不存在 → 404', (await app.request('/v1/chat/completions', chatInit({ model: 'zz-1/x' }))).status, 404);
check('旧格式的 id → 404', (await app.request('/v1/chat/completions', chatInit({ model: 'workbuddy/hy4free' }))).status, 404);
const legacy = await (await app.request('/v1/chat/completions', chatInit({ model: 'workbuddy/hy4free' }))).json();
check('旧格式的报错里给出新写法', legacy.error.message.includes('wb-'), true);
check('非法 JSON → 400', (await app.request('/v1/chat/completions', { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: '{oops' })).status, 400);

// ---- 9. 429 → 原样回给客户端，账号保持 ready，且不偷偷换号 ----
//
// 上游的 429 是**按模型**限的（同一账号换模型照样能用）。网关不再记模型级冷却
// （2026-11-13 删掉了 `core/model-cooldown.ts`，理由见 `routes/openai.ts` 里那段注释）：
// 「什么时候恢复」上游不发 `Retry-After`、真实时间只写在中文 msg 里，网关猜不出来，
// 与其记一个假的到期时间并在转发前拦掉本来能成功的请求，不如如实转发。
//
// 所以这里断言的是：**账号状态不被污染**、**不换号重试**、**同账号别的模型照常能用**。
const { UpstreamError } = await import('../src/shared/upstream-error.ts');
let attempts = 0;
fake.chatAs = async () => {
  attempts += 1;
  throw new UpstreamError(429, '上游限流', { code: 'rate_limited', retryAt: Date.now() + 60000 });
};
const limited = await app.request('/v1/chat/completions', chatInit({ model: 'wb-1/hy4free', messages: [] }));
check('429 → 429', limited.status, 429);
check('只打了一次上游（不换号）', attempts, 1);
check('账号**没有**被标成 cooldown', accounts.getAccount('wb-1').status, 'ready');
check('429 的错误码原样透传', (await limited.json()).error.code, 'rate_limited');

// **同一个模型再请求会真的再打一次上游**：网关不再自己拦。
// 这是刻意的——上游可能已经恢复，拦下来就等于替上游撒谎。
const retried = await app.request('/v1/chat/completions', chatInit({ model: 'wb-1/hy4free', messages: [] }));
check('同一个模型再请求 → 仍然 429', retried.status, 429);
check('网关不拦，确实又打了一次上游', attempts, 2);

// 同账号的**别的**模型不受影响 —— 这正是「上游让你换模型，网关得让换」。
fake.chatAs = async () => ({ kind: 'json', status: 200, body: { ok: true } });
check(
  '同账号的另一个模型照常能用',
  (await app.request('/v1/chat/completions', chatInit({ model: 'wb-1/other', messages: [] }))).status,
  200,
);

// 别的账号不受影响：这就是「不换号」的反面证据（wb-1 的这个模型在 429，
// 网关没有拿 wb-2 去顶它的位置，也没有把 wb-2 一起停掉）。
check('另一个号仍然可以请求', (await app.request('/v1/chat/completions', chatInit({ model: 'wb-2/hy4free', messages: [] }))).status, 200);

// ---- 10. 401 → invalid，503 且提示重新登录（401 才是账号级问题）----
accounts.markReady('wb-1');
fake.chatAs = async () => {
  throw new UpstreamError(401, 'token 失效', { code: 'unauthorized' });
};
check('401 → 401', (await app.request('/v1/chat/completions', chatInit({ model: 'wb-1/hy4free', messages: [] }))).status, 401);
check('账号被标成 invalid', accounts.getAccount('wb-1').status, 'invalid');
const invalidRes = await app.request('/v1/chat/completions', chatInit({ model: 'wb-1/hy4free', messages: [] }));
check('失效的账号 → 503', invalidRes.status, 503);
check('失效提示里让去管理台重新登录', (await invalidRes.json()).error.message.includes('重新登录'), true);

// ---- 11. 停用的账号 ----
accounts.markReady('wb-1');
accounts.setStatus('wb-1', 'disabled');
check('停用的账号 → 503', (await app.request('/v1/chat/completions', chatInit({ model: 'wb-1/hy4free', messages: [] }))).status, 503);

// ---- 12. 删账号后模型消失 ----
accounts.removeAccount('wb-2');
const afterDelete = await (await app.request('/v1/models', { headers: bearer })).json();
check('删掉的账号不再出现在模型列表', afterDelete.data.map((m) => m.id), ['wb-1/hy4free']);
check('序号不回收：新账号是 wb-3', accounts.addAccount({ channelId: 'wb', idPrefix: 'wb', credential: {} }).id, 'wb-3');

channels.splice(0, channels.length, ...saved);
// 先关库再删临时目录：Windows 上删不掉一个被打开的文件（EPERM）。
const { closeDb } = await import('../src/shared/db.ts');
closeDb();
fs.rmSync(tempData, { recursive: true, force: true });
console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
