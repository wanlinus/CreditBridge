// 回归测试：直接调 profile-models 的改写函数，验证它产出的 YAML 块格式对不对（尤其 reasoningEfforts）。
import { applyAggregateModels, normalizeModel } from '../lib/profile-models.js';

const lines = [
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  '    providers:',
  '      jf:',
  '        displayName: jf',
  '        baseURL: http://192.168.1.100:7801/v1',
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
    // 网关现在**总会**给能思考的模型报一份档位表（兜底在 `shared/model-settings.ts`），
    // 插件不再自己补一套，所以测试里也得照网关的真实形状给。
    reasoningEfforts: ['off', 'low', 'medium', 'high', 'xhigh'],
    input: ['text'],
  }),
  normalizeModel({ id: 'wb-1/auto', name: 'wb-1/Auto', context_length: 256000, reasoning: false }),
];

const result = applyAggregateModels(lines, models);
console.log('found=' + result.found + ' changed=' + result.changed);
console.log('----- 生成的 models 段 -----');
console.log(result.lines.join('\n'));

// 断言
const text = result.lines.join('\n');

// ---- 第二组：profile 里的旧 contextWindow 不再是权威，网关值直接覆盖 ----
//
// 2026-11-10 那会儿同步会尊重「用户在 ⚙ 里调过的值」（`min(用户值, 网关值)`），
// 因为那时 profile 也有一份手改入口。现在设置只在网关 `/models` 页改，⚙ 和它的
// `/model-config` 都删了——再保留那种合并，只会让「网关显示的和 profile 写的不一致」
// 活下来，而且不报错。
const preservedLines = [
  '- id: llm-pi-ai',
  '  config:',
  '    providers:',
  '      jf:',
  '        baseURL: http://192.168.1.100:7801/v1',
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

  ['profile 里的旧值被网关值覆盖（网关是唯一事实源）', cwOf(preserved, 'wb-1/hy4free') === 1000000],
  ['profile 里的超大值也被网关值覆盖', cwOf(preserved, 'wb-1/too-big') === 1000000],
  ['profile 里没有的新模型用网关值', cwOf(preserved, 'wb-1/new') === 640000],
];

// ---- 第三组：档位表照抄网关，插件只做格式转换 ----
//
// `none → off` 的归一、以及"上游没报就用兜底"，都已经搬到网关
// （`cb-gateway/src/shared/model-settings.ts`）。插件这边只管把数组写成
// DSH 认的字典：`off` 的值是 `null`，其余档位键值同名。
const custom = applyAggregateModels(lines, [
  normalizeModel({
    id: 'lo-1/mimo-v2.5',
    name: 'lo-1/MiMo V2.5',
    context_length: 1048576,
    reasoning: true,
    reasoningEfforts: ['off', 'low', 'high'],
    input: ['text'],
  }),
]).lines.join('\n');
checks.push(
  ['档位表照抄三档（off/low/high）', /reasoningEfforts:\n\s+off: null\n\s+low: low\n\s+high: high/.test(custom)],
  ['没有补出上游没给的 medium', !/reasoningEfforts:[\s\S]*?medium:/.test(custom)],
);

// ---- 第四组：0 个模型时的两分流（全关 vs 取不到）----
//
// `/api/models` 只回 `data`，所以「所有通道都被关掉」和「没登录 / key 没权限」都表现
// 为 0 个模型。网关把 `listed` 单独暴露在 `/api/health` 上，正是为了让同步方分清：
//
//   全关     → 写空 `models: []`（用户明确意图，DSH 里那些模型该消失）
//   取不到   → 跳过、不动 profile（一次抖动就清空会让模型凭空消失）
//
// 这里必须用 mock fetch，因为要断言「请求了哪些 URL、写没写盘」。
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

  /** `/api/models` 回 models；`/api/health` 回 health（null = 请求失败）。 */
  const mock = (models, health) => async (url) => {
    if (url.includes('/api/models')) return { ok: true, json: async () => ({ object: 'list', data: models }) };
    if (url.includes('/api/health')) {
      if (!health) throw new Error('health unreachable');
      return { ok: true, json: async () => health };
    }
    throw new Error('unexpected url ' + url);
  };

  // 4a. 全关 → 写空
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

  // 4b. 0 模型但没全关 → 跳过
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

  // 4c. 0 模型且 /api/health 不可达 → 跳过（宁可留旧）
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

  // 4d. 有模型时不额外问 health
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
