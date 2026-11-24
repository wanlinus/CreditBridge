// Qoder 模型名单解析与名字对齐的回归测试。
//
// 起因有两件：
//   1. 早先把 12 个模型名写死在代码里。模型是上游资产会变，写死等于埋一个
//      「上游换了模型、网关还在报旧名字」的雷。改成跑 `--list-models` 现取，
//      于是解析必须稳——输出格式变了要能当场发现。
//   2. CLI 对不存在的模型名**不报错**，静默退回 auto。所以名字对齐（尤其大小写）
//      错了不会有任何提示，只会让用户以为在用 A 实际在用 auto，还照样扣积分。
//
// 跑：node test/qoder-models.mjs

import assert from 'node:assert/strict';
import { buildModelList, resolveModelName } from '../src/channels/qoder/models.ts';

// ---------------------------------------------------------------- 名字对齐

const known = ['Auto', 'Fast', 'DeepSeek-V4-Pro', 'GLM-5.3-Flash'];

const resolveCases = [
  { name: '原样命中', input: 'DeepSeek-V4-Pro', expect: 'DeepSeek-V4-Pro' },
  { name: '全小写也能对上', input: 'deepseek-v4-pro', expect: 'DeepSeek-V4-Pro' },
  { name: '混合大小写', input: 'GlM-5.3-FlAsH', expect: 'GLM-5.3-Flash' },
  { name: '不在名单里返回 undefined', input: 'NotAModel', expect: undefined },
  { name: '空串返回 undefined', input: '', expect: undefined },
  { name: '只差一个字符就不能算命中', input: 'DeepSeek-V4', expect: undefined },
];

// ---------------------------------------------------------------- 倍率拼装

let failed = 0;

const rateCases = [
  {
    name: '快照里的模型拼上倍率',
    input: ['DeepSeek-V4-Pro'],
    expectName: 'DeepSeek-V4-Pro · 0.50x',
    // **取 context_config 最大的那一档（1M），不是 `max_input_tokens`（96000）**：
    // 后者是单次输入上限，不是窗口上限。2026-11-13 在容器里 MITM 抓 `model/list`
    // 确认：所有 13 个模型都给 200K/400K/1M 三档，默认 200K，上限 1M。
    expectContext: 1000000,
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
  // ---- 能力字段：从快照的 canThink / efforts / isVision 来 ----
  //
  // 2026-11 用户报「Qoder 的模型推理和输入都是空」。第一版修法是读上游的
  // `is_reasoning`，但那个字段**不可靠**：DeepSeek-Flash / Kimi-K3.1-Pro 报 false，
  // 而它们的 `thinking_config.enabled.efforts` 有 high/low/max，实际支持思考。
  // 用户看到 DeepSeek-Flash 显示「—」第二次提出来，才定位到根因。
  // 现在能力一律从 `thinking_config` 归一化后的快照字段来。
  {
    name: '推理模型报 reasoning=true',
    input: ['DeepSeek-V4-Pro'],
    expectReasoning: true,
    expectEfforts: ['none', 'high', 'max'],
    expectDefaultEffort: 'max',
  },
  {
    // is_reasoning=false 但 thinking_config 有档位 → 实际支持思考
    name: 'DeepSeek-Flash 支持思考（is_reasoning 是误导字段）',
    input: ['DeepSeek-Flash'],
    expectReasoning: true,
    expectEfforts: ['none', 'high', 'max', 'low'],
    expectDefaultEffort: 'high',
  },
  {
    // Kimi-K3.1-Pro 的 thinking_config 没有 disabled 段 → 能开不能关，档位表里不带 none
    name: 'Kimi-K3.1-Pro 支持思考但不能关（档位表不含 none）',
    input: ['Kimi-K3.1-Pro'],
    expectReasoning: true,
    expectEfforts: ['high', 'low', 'max'],
  },
  {
    // Auto / Fast 是路由别名，上游没给 thinking_config
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
  // 2026-11-11 重新抓包补上的新模型：CLI 名单里有它，旧快照（11-09）没有，
  // 所以那一版在页面上显示成「推理 — / 输入 —」。现在快照覆盖到它了。
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
    // 快照里没有的模型：`reasoning` / `input` 应当**不存在**（不是 false / 空数组），
    // 这样前端才是「—」，而不是编一个「不推理 / 纯文本」。
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

// 单独强调：名单为空时不能崩，返回 undefined 由调用方决定怎么处理。
try {
  assert.equal(resolveModelName('Auto', []), undefined);
  console.log('  ok   resolve: 空名单不崩');
} catch {
  failed += 1;
  console.log('  FAIL resolve: 空名单不崩');
}

const total = resolveCases.length + rateCases.length;
// 注：原先 +3 是 parseCases 与两条 stderr 断言；CLI 移除后那几项已删。
console.log(failed === 0 ? `\n全部通过（${total} 项）` : `\n${failed}/${total} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
