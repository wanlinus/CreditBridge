import assert from 'node:assert/strict';
import { buildModelList, cleanStderr, parseModelList, resolveModelName } from '../src/channels/qoder/models.ts';

const parseCases = [
  {
    name: '实测输出（表头 MODEL + 一列）',
    input: 'MODEL\nAuto\nFast\nQwen3.8-Max\nDeepSeek-V4-Pro\nMiniMax-M3.1-Flash\n',
    expect: ['Auto', 'Fast', 'Qwen3.8-Max', 'DeepSeek-V4-Pro', 'MiniMax-M3.1-Flash'],
  },
  {
    name: '空行要跳过',
    input: 'MODEL\n\nAuto\n\n\nFast\n\n',
    expect: ['Auto', 'Fast'],
  },
  {
    name: 'CRLF 行尾（Windows 上真会遇到）',
    input: 'MODEL\r\nAuto\r\nGLM-5.3\r\n',
    expect: ['Auto', 'GLM-5.3'],
  },
  {
    name: '将来变成多列表格时取第一列，且表头要过滤掉',
    input: 'MODEL      RATE\nAuto       1.00x\nGLM-5.3    0.69x\n',
    expect: ['Auto', 'GLM-5.3'],
  },
  {
    name: '单空格不能被当成列分隔',
    input: 'MODEL\nSome Model\n',
    expect: ['Some Model'],
  },
  {
    name: '重复项去重',
    input: 'MODEL\nAuto\nAuto\nFast\n',
    expect: ['Auto', 'Fast'],
  },
  {
    name: '纯空输出',
    input: '',
    expect: [],
  },
  {
    name: '只有表头',
    input: 'MODEL\n',
    expect: [],
  },
];

const known = ['Auto', 'Fast', 'DeepSeek-V4-Pro', 'GLM-5.3-Flash'];

const resolveCases = [
  { name: '原样命中', input: 'DeepSeek-V4-Pro', expect: 'DeepSeek-V4-Pro' },
  { name: '全小写也能对上', input: 'deepseek-v4-pro', expect: 'DeepSeek-V4-Pro' },
  { name: '混合大小写', input: 'GlM-5.3-FlAsH', expect: 'GLM-5.3-Flash' },
  { name: '不在名单里返回 undefined', input: 'NotAModel', expect: undefined },
  { name: '空串返回 undefined', input: '', expect: undefined },
  { name: '只差一个字符就不能算命中', input: 'DeepSeek-V4', expect: undefined },
];

const rateCases = [
  {
    name: '快照里的模型拼上倍率',
    input: ['DeepSeek-V4-Pro'],
    expectName: 'DeepSeek-V4-Pro · 0.50x',
    expectContext: 96000,
  },
  {
    name: '快照里没有的模型退回纯名字 + 默认窗口',
    input: ['Some-New-Model'],
    expectName: 'Some-New-Model',
    expectContext: 200000,
  },
  {
    name: 'id 保持裸模型名（不拼倍率）',
    input: ['GLM-5.3'],
    expectId: 'GLM-5.3',
  },
  {
    name: '倍率 1.00 也要拼（不省略）',
    input: ['Kimi-K3.1-Pro'],
    expectName: 'Kimi-K3.1-Pro · 1.00x',
  },
  {
    name: '推理模型报 reasoning=true',
    input: ['DeepSeek-V4-Pro'],
    expectReasoning: true,
    expectEfforts: ['none', 'high', 'max'],
    expectDefaultEffort: 'max',
  },
  {
    name: 'DeepSeek-Flash 支持思考（is_reasoning 是误导字段）',
    input: ['DeepSeek-Flash'],
    expectReasoning: true,
    expectEfforts: ['none', 'high', 'max', 'low'],
    expectDefaultEffort: 'high',
  },
  {
    name: 'Kimi-K3.1-Pro 支持思考但不能关（档位表不含 none）',
    input: ['Kimi-K3.1-Pro'],
    expectReasoning: true,
    expectEfforts: ['high', 'low', 'max'],
  },
  {
    name: 'Auto 是路由别名，不报推理能力',
    input: ['Auto'],
    expectReasoning: false,
    expectEfforts: undefined,
  },
  {
    name: '支持图像时报 input 含 image',
    input: ['DeepSeek-V4-Pro'],
    expectInput: ['text', 'image'],
  },
  {
    name: '快照里没有的模型不报能力（不编）',
    input: ['Some-New-Model'],
    expectReasoning: undefined,
    expectInput: undefined,
  },
  {
    name: '新模型 Qwen4-Max-Preview 有完整能力',
    input: ['Qwen4-Max-Preview'],
    expectName: 'Qwen4-Max-Preview · 0.10x',
    expectReasoning: true,
    expectInput: ['text', 'image'],
  },
];

for (const item of rateCases) {
  const [model] = buildModelList(item.input, 200000, 8192);
  try {
    if (item.expectName !== undefined) assert.equal(model.name, item.expectName);
    if (item.expectContext !== undefined) assert.equal(model.context_length, item.expectContext);
    if (item.expectId !== undefined) assert.equal(model.id, item.expectId);
    if (item.expectReasoning !== undefined) assert.equal(model.reasoning, item.expectReasoning);
    if (item.expectInput !== undefined) assert.deepEqual(model.input, item.expectInput);
    if (item.expectEfforts !== undefined) assert.deepEqual(model.reasoningEfforts, item.expectEfforts);
    if (item.expectDefaultEffort !== undefined) assert.equal(model.defaultReasoningEffort, item.expectDefaultEffort);
    if (item.expectReasoning === undefined && item.expectInput === undefined && item.input[0] === 'Some-New-Model') {
      assert.equal(Object.prototype.hasOwnProperty.call(model, 'reasoning'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(model, 'input'), false);
    }
    console.log(`  ok   rate: ${item.name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL rate: ${item.name}`);
    console.log(`       ${error.message}`);
    console.log(
      `       实际 name=${model.name} id=${model.id} context=${model.context_length} reasoning=${model.reasoning} input=${JSON.stringify(model.input)}`,
    );
  }
}

let failed = 0;

for (const item of parseCases) {
  const got = parseModelList(item.input);
  try {
    assert.deepEqual(got, item.expect);
    console.log(`  ok   parse: ${item.name}`);
  } catch {
    failed += 1;
    console.log(`  FAIL parse: ${item.name}`);
    console.log(`       期望 ${JSON.stringify(item.expect)}`);
    console.log(`       实际 ${JSON.stringify(got)}`);
  }
}

for (const item of resolveCases) {
  const got = resolveModelName(item.input, known);
  try {
    assert.equal(got, item.expect);
    console.log(`  ok   resolve: ${item.name}`);
  } catch {
    failed += 1;
    console.log(`  FAIL resolve: ${item.name}`);
    console.log(`       期望 ${JSON.stringify(item.expect)} 实际 ${JSON.stringify(got)}`);
  }
}

try {
  assert.equal(resolveModelName('Auto', []), undefined);
  console.log('  ok   resolve: 空名单不崩');
} catch {
  failed += 1;
  console.log('  FAIL resolve: 空名单不崩');
}

const noisyStderr = [
  '(node:123) [DEP0169] DeprecationWarning: `url.parse()` behavior is not standardized and prone to errors that have security implications. Use the WHATWG URL API instead. CVEs are not issued for `url.parse()` vulnerabilities.',
  '(Use `node --trace-deprecation ...` to show where the warning was created)',
  'Not logged in. Run \u001b[1mqodercli login\u001b[0m to authenticate.',
].join('\n');

try {
  const cleaned = cleanStderr(noisyStderr);
  assert.equal(cleaned.includes('DeprecationWarning'), false);
  assert.equal(cleaned.includes('trace-deprecation'), false);
  assert.equal(cleaned.includes('\u001b'), false);
  assert.equal(cleaned.includes('Not logged in'), true);
  console.log('  ok   stderr: 弃用警告被摘掉，真实原因留下');
} catch {
  failed += 1;
  console.log('  FAIL stderr: 清洗结果不对');
}

try {
  assert.equal(cleanStderr(''), '');
  assert.equal(cleanStderr('\n\n  \n'), '');
  console.log('  ok   stderr: 空输入不崩');
} catch {
  failed += 1;
  console.log('  FAIL stderr: 空输入');
}

const total = parseCases.length + resolveCases.length + rateCases.length + 3;
console.log(failed === 0 ? `\n全部通过（${total} 项）` : `\n${failed}/${total} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
