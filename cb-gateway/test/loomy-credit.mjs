// Loomy 单次积分口径的自测。
//
// 钉住的是 2026-11-13 发现的「Loomy 积分统计恒为 0」：上游 `usage` 帧里的单次积分叫
// **`points_consumed`**，而账本统一读 `credit`（见 `ledger.ts`）。通道不做换算的话，
// 账本里 Loomy 的每一行 `credit` 都是 `null`——**不报错**，只是让概览的「今日消耗」
// 「累计消耗」不含 Loomy、按通道的图里 Loomy 恒为 0、账号详情页的「今日消耗」也是 0。
//
// 实测原始帧（2026-11-13，走网关打一次 Loomy）：
//   "usage":{"prompt_tokens":32,"completion_tokens":12,"total_tokens":44,
//            "completion_tokens_details":{"reasoning_tokens":10},"points_consumed":1}
//
// 不依赖网络：把 `fetch` 换成假实现，喂真实形状的 SSE。
//
// 运行：node test/loomy-credit.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-loomy-credit-'));
process.env.QB_DATA_DIR = tempData;

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

const { chatLoomy } = await import('../src/channels/loomy/upstream.ts');

const account = {
  id: 'lo-9',
  channelId: 'loomy',
  status: 'ready',
  credential: {
    session: 'a'.repeat(32),
    userId: 'u-1',
    phone: '13800000000',
    expiresAt: Date.now() + 86400_000,
    source: 'login',
  },
};

/** 造一段和实测同形的 SSE。`points` / `credit` 传 null 表示那一帧不带该字段。 */
function sse({ points = null, credit = null } = {}) {
  const usage = {
    prompt_tokens: 32,
    completion_tokens: 12,
    total_tokens: 44,
    prompt_tokens_details: {},
    completion_tokens_details: { reasoning_tokens: 10 },
  };
  if (points !== null) usage.points_consumed = points;
  if (credit !== null) usage.credit = credit;
  const frame = (patch) => `data: ${JSON.stringify(patch)}\n\n`;
  return (
    frame({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }) +
    frame({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] }) +
    frame({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }) +
    'data: [DONE]\n\n'
  );
}

let captured = null;

/** 换掉 fetch：`stream=true` 走流式分支，否则走聚合分支。 */
function installFetch(text, { stream = true } = {}) {
  captured = null;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: {
      get: (key) => (String(key).toLowerCase() === 'content-type' ? (stream ? 'text/event-stream' : 'application/json') : null),
    },
    body: {
      async *[Symbol.asyncIterator]() {
        yield new TextEncoder().encode(text);
      },
    },
    text: async () => text,
  });
}

async function call(streamWanted = true) {
  const request = {
    body: { model: 'DeepSeek-V4.1-Flash', messages: [{ role: 'user', content: 'hi' }], stream: streamWanted },
    onUsage: (value) => {
      captured = value;
    },
  };
  const outcome = await chatLoomy(account, request);
  if (outcome.kind === 'stream') {
    // 必须把流消费掉：`onUsage` 在生成器的 finally 里回调。
    for await (const _chunk of outcome.body) {
      // 只为了触发 finally
    }
  }
  return outcome;
}

// ---- 1. 实测形状：上游报 points_consumed，账本要拿到 credit ----
console.log('--- 1. 实测形状（"points_consumed":35）---');
installFetch(sse({ points: 35 }));
await call();
check('onUsage 被回调了', captured !== null);
check('points_consumed 换算成 credit', captured?.credit, 35);
check('token 字段原样保留', captured?.total_tokens, 44);
check('原字段没有被删掉（透传不信道）', captured?.points_consumed, 35);

// ---- 2. 上游哪天改回 credit：以 credit 为准，不能反过来覆盖 ----
console.log('\n--- 2. 上游直接报 credit（credit=7, points_consumed=99）---');
installFetch(sse({ credit: 7, points: 99 }));
await call();
check('已有 credit 时不覆盖', captured?.credit, 7);

// ---- 3. 两个字段都没有：不能瞎编 0 ----
console.log('\n--- 3. 帧里没有积分字段 ---');
installFetch(sse({}));
await call();
check('没有积分字段时 credit 保持 undefined', captured?.credit === undefined, true);
check('token 仍然记录', captured?.total_tokens, 44);

// ---- 4. 调用方要非流式：聚合分支也要换算 ----
console.log('\n--- 4. 非流式聚合分支（stream:false）---');
installFetch(sse({ points: 42 }), { stream: false });
await call(false);
check('非流式分支同样换算', captured?.credit, 42);

// ---- 5. points_consumed 为 0 是「确实免费」，不是「不知道」 ----
console.log('\n--- 5. points_consumed 为 0 ---');
installFetch(sse({ points: 0 }));
await call();
check('0 要如实记 0（不能当缺省丢掉）', captured?.credit, 0);

// 先关库再删临时目录：Windows 上删不掉一个被打开的文件（EPERM）。
const { closeDb } = await import('../src/shared/db.ts');
closeDb();
fs.rmSync(tempData, { recursive: true, force: true });
console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
