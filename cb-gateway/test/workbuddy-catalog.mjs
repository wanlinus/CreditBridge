// WorkBuddy 模型目录的回归测试：只测「客户端选择器列哪些模型」这一步。
//
// 起因：2026-11 用户发现 DSH 里有 57 个 WorkBuddy 模型，而客户端选择器只列了 9 行。
// 根因是只读了 `data.models`（全量 66 个：实验分支、补全专用、图片/视频都在里面），
// 没读 `data.agents[].models`（agent 真正能跑的 17 个）与三个路由预设。
//
// 跑：node test/workbuddy-catalog.mjs
import assert from 'node:assert/strict';

const { selectorOrder } = await import('../src/channels/workbuddy/models.ts');

const cases = [
  {
    name: '预设在前、agent 的模型在后，按 agents[].models 的原始顺序',
    data: {
      models: [{ id: 'fast-model' }, { id: 'hy4free' }, { id: 'glm-5.3' }],
      agents: [{ models: ['hy4free', 'glm-5.3'] }],
    },
    expect: ['fast-model', 'balanced-model', 'deep-model', 'hy4free', 'glm-5.3'],
  },
  {
    name: '多个 agent 时取并集并去重，先出现的顺序优先',
    data: {
      models: [],
      agents: [{ models: ['a', 'b'] }, { models: ['b', 'c'] }],
    },
    expect: ['fast-model', 'balanced-model', 'deep-model', 'a', 'b', 'c'],
  },
  {
    name: '没有 agents 字段（老配置）返回 null，调用方退回全量',
    data: { models: [{ id: 'x' }] },
    expect: null,
  },
  {
    name: 'agents 存在但模型全为空，也当没有选择器信息',
    data: { models: [{ id: 'x' }], agents: [{ models: [] }, {}] },
    expect: null,
  },
  {
    name: 'agent 列表里的非字符串、空串丢掉',
    data: { models: [], agents: [{ models: ['a', '', 42, null, 'a'] }] },
    expect: ['fast-model', 'balanced-model', 'deep-model', 'a'],
  },
];

let failed = 0;
for (const item of cases) {
  const got = selectorOrder(item.data);
  try {
    assert.deepEqual(got, item.expect, '不一致');
    console.log(`  ok   ${item.name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${item.name}`);
    console.log(`       期望 ${JSON.stringify(item.expect)}，实际 ${JSON.stringify(got)}`);
  }
}

console.log(failed === 0 ? `\n全部通过（${cases.length} 项）` : `\n${failed}/${cases.length} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
