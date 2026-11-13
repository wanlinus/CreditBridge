import { applyAggregateModels, normalizeModel } from '../lib/profile-models.js';

const lines = [
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  '    providers:',
  '      jf:',
  '        displayName: jf',
  '        baseURL: http://10.0.0.45:7801/v1',
  '        models:',
  '          - id: wb-1/old-model',
  '            name: old',
  '            customField: keep-me',
  '',
  '- id: permission',
];

const models = [
  normalizeModel({
    id: 'wb-1/hy4free',
    name: 'wb-1/Hy4 · 0.00x',
    context_length: 960000,
    max_output_tokens: 64000,
    reasoning: true,
    input: ['text'],
  }),
  normalizeModel({ id: 'wb-1/auto', name: 'wb-1/Auto', context_length: 256000, reasoning: false }),
];

const result = applyAggregateModels(lines, models);
console.log('found=' + result.found + ' changed=' + result.changed);
console.log('----- 生成的 models 段 -----');
console.log(result.lines.join('\n'));

const text = result.lines.join('\n');

const preservedLines = [
  '- id: llm-pi-ai',
  '  config:',
  '    providers:',
  '      jf:',
  '        baseURL: http://10.0.0.45:7801/v1',
  '        models:',
  '          - id: wb-1/hy4free',
  '            name: "wb-1/Hy4 · 0.00x"',
  '            contextWindow: 300000',
  '          - id: wb-1/too-big',
  '            name: big',
  '            contextWindow: 2000000',
  '',
  '- id: permission',
];
const preservedModels = [
  normalizeModel({ id: 'wb-1/hy4free', name: 'wb-1/Hy4 · 0.00x', context_length: 1000000 }),
  normalizeModel({ id: 'wb-1/too-big', name: 'big', context_length: 1000000 }),
  normalizeModel({ id: 'wb-1/new', name: 'new', context_length: 640000 }),
];
const preserved = applyAggregateModels(preservedLines, preservedModels).lines.join('\n');
const cwOf = (block, id) => {
  const re = new RegExp(`- id: ${id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\n(?:.*\\n)*?\\s+contextWindow: (\\d+)`, 'u');
  const m = re.exec(block);
  return m ? Number(m[1]) : null;
};

const checks = [
  ['有 reasoningEfforts', text.includes('reasoningEfforts:')],
  ['off 档写成 null', /reasoningEfforts:\n\s+off: null/.test(text)],
  ['low 档是字符串', /off: null\n\s+low: low/.test(text)],
  ['非推理模型不带 reasoningEfforts', (text.match(/reasoningEfforts:/g) || []).length === 1],
  ['contextWindow 写进去了', text.includes('contextWindow: 960000')],
  ['maxTokens 写进去了', text.includes('maxTokens: 64000')],
  ['不在新列表里的旧条目整段去掉（customField 跟着走）', !text.includes('customField: keep-me')],
  ['旧模型 id 被换掉了', !text.includes('wb-1/old-model')],
  ['下一个顶层条目还在', text.includes('- id: permission')],
  ['名字用 JSON 引号包住', text.includes('name: "wb-1/Hy4 · 0.00x"')],

  ['用户调小到 300000 被保住（不被网关的 1000000 覆盖）', cwOf(preserved, 'wb-1/hy4free') === 300000],
  ['用户值超过网关时按网关封顶', cwOf(preserved, 'wb-1/too-big') === 1000000],
  ['profile 里没有的新模型用网关值', cwOf(preserved, 'wb-1/new') === 640000],
];

const custom = applyAggregateModels(lines, [
  normalizeModel({
    id: 'lo-1/mimo-v2.5',
    name: 'lo-1/MiMo V2.5',
    context_length: 1048576,
    reasoning: true,
    reasoningEfforts: ['none', 'low', 'high'],
    input: ['text'],
  }),
]).lines.join('\n');
checks.push(
  ['自定义档位照抄上游（只有 none/low/high 三档）', /reasoningEfforts:\n(\s+(?:off: null|low: low|high: high)\n){3}\s*$|reasoningEfforts:\n\s+off: null\n\s+low: low\n\s+high: high/.test(custom)],
  ['上游的 none 映射成 DSH 的 off', /reasoningEfforts:\n\s+off: null/.test(custom)],
  ['没有补出上游没给的 medium', !/reasoningEfforts:[\s\S]*?medium:/.test(custom)],
);

{
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { syncProfileModels } = await import('../lib/profile-models.js');

  const seed = `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      qb:
        displayName: 积分桥
        baseURL: http://127.0.0.1:7801/v1
        models:
          - id: wb-1/hy4free
            name: "wb-1/Hy4 · 0.00x"
`;

  const freshProfile = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-sync-test-'));
    const file = path.join(dir, 'cordis.patch.yml');
    fs.writeFileSync(file, seed, 'utf8');
    return file;
  };
  const cleanup = (file) => fs.rmSync(path.dirname(file), { recursive: true, force: true });

  const mock = (models, health) => async (url) => {
    if (url.includes('/api/models')) return { ok: true, json: async () => ({ object: 'list', data: models }) };
    if (url.includes('/api/health')) {
      if (!health) throw new Error('health unreachable');
      return { ok: true, json: async () => health };
    }
    throw new Error('unexpected url ' + url);
  };

  {
    const file = freshProfile();
    const r = await syncProfileModels({
      profilePath: file,
      base: 'http://gw',
      auth: 'Bearer k',
      fetchImpl: mock([], { channels: { workbuddy: { listed: false }, trae: { listed: false } } }),
    });
    checks.push(
      ['全关时 wrote=true', r.wrote === true],
      ['全关时写空 models 段', /models: \[\]/u.test(fs.readFileSync(file, 'utf8'))],
    );
    cleanup(file);
  }

  {
    const file = freshProfile();
    const before = fs.readFileSync(file, 'utf8');
    const r = await syncProfileModels({
      profilePath: file,
      base: 'http://gw',
      auth: 'Bearer k',
      fetchImpl: mock([], { channels: { workbuddy: { listed: true } } }),
    });
    checks.push(
      ['0 模型且未全关时 skipped', r.wrote === false && r.reason === 'empty'],
      ['0 模型且未全关时 profile 未变', fs.readFileSync(file, 'utf8') === before],
    );
    cleanup(file);
  }

  {
    const file = freshProfile();
    const before = fs.readFileSync(file, 'utf8');
    const r = await syncProfileModels({
      profilePath: file,
      base: 'http://gw',
      auth: 'Bearer k',
      fetchImpl: mock([], null),
    });
    checks.push(
      ['health 不可达时 skipped', r.wrote === false],
      ['health 不可达时 profile 未变', fs.readFileSync(file, 'utf8') === before],
    );
    cleanup(file);
  }

  {
    const file = freshProfile();
    let healthAsked = false;
    const r = await syncProfileModels({
      profilePath: file,
      base: 'http://gw',
      auth: 'Bearer k',
      fetchImpl: async (url) => {
        if (url.includes('/api/health')) healthAsked = true;
        if (url.includes('/api/models')) {
          return {
            ok: true,
            json: async () => ({ object: 'list', data: [{ id: 'wb-2/glm', name: 'wb-2/GLM · 0.5x', context_length: 100, max_output_tokens: 10 }] }),
          };
        }
        throw new Error('unexpected');
      },
    });
    checks.push(
      ['有模型时正常写入', r.wrote === true],
      ['有模型时不去问 health', healthAsked === false],
    );
    cleanup(file);
  }
}

let bad = 0;
for (const [name, ok] of checks) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + name);
  if (!ok) bad += 1;
}
console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
process.exit(bad === 0 ? 0 : 1);
