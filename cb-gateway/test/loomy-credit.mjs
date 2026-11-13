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
    for await (const _chunk of outcome.body) {
    }
  }
  return outcome;
}

console.log('--- 1. 实测形状（"points_consumed":35）---');
installFetch(sse({ points: 35 }));
await call();
check('onUsage 被回调了', captured !== null);
check('points_consumed 换算成 credit', captured?.credit, 35);
check('token 字段原样保留', captured?.total_tokens, 44);
check('原字段没有被删掉（透传不信道）', captured?.points_consumed, 35);

console.log('\n--- 2. 上游直接报 credit（credit=7, points_consumed=99）---');
installFetch(sse({ credit: 7, points: 99 }));
await call();
check('已有 credit 时不覆盖', captured?.credit, 7);

console.log('\n--- 3. 帧里没有积分字段 ---');
installFetch(sse({}));
await call();
check('没有积分字段时 credit 保持 undefined', captured?.credit === undefined, true);
check('token 仍然记录', captured?.total_tokens, 44);

console.log('\n--- 4. 非流式聚合分支（stream:false）---');
installFetch(sse({ points: 42 }), { stream: false });
await call(false);
check('非流式分支同样换算', captured?.credit, 42);

console.log('\n--- 5. points_consumed 为 0 ---');
installFetch(sse({ points: 0 }));
await call();
check('0 要如实记 0（不能当缺省丢掉）', captured?.credit, 0);

fs.rmSync(tempData, { recursive: true, force: true });
console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
