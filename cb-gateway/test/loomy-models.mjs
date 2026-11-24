// Loomy 模型能力解析的回归测试。
//
// ## 起因
//
// 2026-11 用户报「lo 没办法设置思考强度」。查下来是网关读错了字段：能力埋在
// `capabilities.reasoning` 里，而代码读的是顶层 `raw.reasoning` / `raw.supports_reasoning`
// ——**上游从来没给过那两个字段**。于是所有 Loomy 模型都被报成「不支持推理」，
// DSH 的思考强度选择器整个不出现。
//
// 上游真实响应（实测抓的）：
//
//   "capabilities": { "reasoning": true, "input_modalities": ["text"], … },
//   "reasoning_efforts": ["low","medium","high","xhigh"],
//   "default_reasoning_effort": "low"
//
// 带 `reasoning_effort` 发请求时思考量确实跟着变（low 129 字符 / xhigh 192 / 不带 260），
// 所以是真支持，纯粹是网关漏报。这里把读法钉死。
//
// 跑：node test/loomy-models.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.QB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-gw-loomy-'));

const { buildModelList } = await import('../src/channels/loomy/models.ts');

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}\n      期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

/** 上游 `/models` 的原始项（按实测形状，只写测试关心的字段）。 */
function upstreamModel(overrides = {}) {
  return {
    object: 'model',
    protocol: 'openai_chat',
    type: 'chat',
    context_length: 1048576,
    max_output_tokens: 131072,
    capabilities: {
      reasoning: true,
      vision: false,
      function_calling: true,
      streaming: true,
      input_modalities: ['text'],
      output_modalities: ['text'],
    },
    reasoning_efforts: ['low', 'medium', 'high', 'xhigh'],
    default_reasoning_effort: 'low',
    ...overrides,
  };
}

/** 装一个假账号 + 拦掉 fetch，返回 `/v1/models` 的处理结果。 */
async function listFrom(rawModels) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/models')) {
      return new Response(JSON.stringify({ data: rawModels }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`测试没桩这个请求：${url}`);
  };
  try {
    const account = {
      id: `probe-${Math.random().toString(36).slice(2)}`,
      channelId: 'loomy',
      seq: 1,
      label: 'x',
      credential: { session: 'fake-session', userId: 'u1' },
      status: 'ready',
      cooldownUntil: null,
      statusMessage: null,
      profile: {},
      createdAt: 0,
      updatedAt: 0,
    };
    return await buildModelList(account, 128000, 8192);
  } finally {
    globalThis.fetch = original;
  }
}

// ---- 1. 能力来自 capabilities ----
console.log('--- 1. 能力读 capabilities.reasoning ---');
let models = await listFrom([upstreamModel({ id: 'spark-x2.6' })]);
check('reasoning 为 true', models[0].reasoning, true);
check('档位照抄上游', models[0].reasoningEfforts, ['low', 'medium', 'high', 'xhigh']);
check('默认档位', models[0].defaultReasoningEffort, 'low');
check('输入模态来自 capabilities', models[0].input, ['text']);

// ---- 2. 不支持推理的模型不报档位 ----
console.log('\n--- 2. 不支持推理时不给档位表 ---');
models = await listFrom([
  upstreamModel({ id: 'Hy-Image-3.5-preview', capabilities: { reasoning: false, input_modalities: ['text', 'image'] } }),
]);
check('reasoning 为 false', models[0].reasoning, false);
check('不报 reasoningEfforts（字段不存在）', Object.prototype.hasOwnProperty.call(models[0], 'reasoningEfforts'), false);
check('不报 defaultReasoningEffort', Object.prototype.hasOwnProperty.call(models[0], 'defaultReasoningEffort'), false);
check('图像模态读得到', models[0].input, ['text', 'image']);

// ---- 3. 上游档位非标准时原样透传 ----
console.log('\n--- 3. 上游档位不是标准四档时原样透传 ---');
models = await listFrom([upstreamModel({ id: 'mimo-v2.5', reasoning_efforts: ['low', 'high'] })]);
check('只有两档就报两档', models[0].reasoningEfforts, ['low', 'high']);

// ---- 4. 顶层旧字段仍然认（留余地） ----
console.log('\n--- 4. 顶层 reasoning 兜底 ---');
models = await listFrom([
  upstreamModel({ id: 'legacy', capabilities: undefined, reasoning: true, reasoning_efforts: ['low', 'high'] }),
]);
check('顶层 reasoning 也认', models[0].reasoning, true);

// ---- 5. anthropic 协议跳过 ----
console.log('\n--- 5. anthropic 协议跳过 ---');
models = await listFrom([
  upstreamModel({ id: 'claude-x', protocol: 'anthropic_messages' }),
  upstreamModel({ id: 'spark-x2.6' }),
]);
check('只剩 openai 协议那批', models.map((m) => m.id), ['spark-x2.6']);

console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail} 项失败`);
assert.equal(fail, 0);
