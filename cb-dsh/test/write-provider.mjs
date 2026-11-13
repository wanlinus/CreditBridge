import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-setup-'));
const profile = path.join(tmp, 'cordis.patch.yml');

process.env.QB_DSH_PROFILE = profile;
process.env.QB_DSH_CONFIG_DIR = path.join(tmp, 'cb-dsh');

const { inspectProvider, writeProvider } = await import('../lib/index.js');

let bad = 0;
const check = (name, ok) => {
  console.log((ok ? '  ✓ ' : '  ✗ ') + name);
  if (!ok) bad += 1;
};
const read = () => fs.readFileSync(profile, 'utf8');

console.log('--- 1. 沿用已有的 apiKeyEnv，只换 baseURL ---');
fs.writeFileSync(
  profile,
  [
    '- id: llm-pi-ai',
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    '  config:',
    '    providers:',
    '      jf:',
    '        displayName: jf',
    '        apiKeyEnv: JF_API_KEY',
    '        api: openai-completions',
    '        baseURL: http://127.0.0.1:7801/v1',
    '        models:',
    '          - id: wb-1/stale',
    '            name: stale',
    '- id: permission',
    '',
  ].join('\n'),
  'utf8',
);

const target = inspectProvider();
check('inspectProvider 找到 provider', target.ok === true && target.found === true);
check('providerId 是 jf', target.providerId === 'jf');
check('沿用它原来的引用 JF_API_KEY', target.ref === 'JF_API_KEY');

const updated = writeProvider({ gatewayBase: 'http://10.0.0.45:7801', credentialRef: target.ref });
console.log('  ' + JSON.stringify(updated));
check('action 是 updated', updated.ok === true && updated.action === 'updated');
check('baseURL 换了新地址', read().includes('baseURL: http://10.0.0.45:7801/v1'));
check('apiKeyEnv 还是 JF_API_KEY', read().includes('apiKeyEnv: JF_API_KEY'));
check('没有往 profile 写明文 apiKey', !/^\s*apiKey:/mu.test(read()));
check('其他顶层条目没动', read().includes('- id: permission'));
check('models 段没被这里改', read().includes('- id: wb-1/stale'));

console.log('--- 2. 残留的明文 apiKey 行要被删掉 ---');
fs.writeFileSync(
  profile,
  [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      jf:',
    '        displayName: jf',
    '        apiKeyEnv: JF_API_KEY',
    '        apiKey: sk-DEADFIELD',
    '        baseURL: http://127.0.0.1:7801/v1',
    '        models: []',
    '- id: permission',
    '',
  ].join('\n'),
  'utf8',
);
const cleaned = writeProvider({ gatewayBase: 'http://10.0.0.45:7801', credentialRef: 'JF_API_KEY' });
check('报告删掉了明文 apiKey', cleaned.ok === true && cleaned.droppedApiKey === true);
check('明文 apiKey 真的没了', !read().includes('sk-DEADFIELD'));
check('apiKeyEnv 还在', read().includes('apiKeyEnv: JF_API_KEY'));

console.log('--- 3. 没有 apiKeyEnv 时补一条 ---');
fs.writeFileSync(
  profile,
  [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      jf:',
    '        displayName: jf',
    '        baseURL: http://127.0.0.1:7801/v1',
    '        models: []',
    '- id: permission',
    '',
  ].join('\n'),
  'utf8',
);
const added = writeProvider({ gatewayBase: 'http://10.0.0.45:7801', credentialRef: 'CB_GATEWAY_API_KEY' });
check('action 是 updated', added.ok === true && added.action === 'updated');
check('补上了 apiKeyEnv', read().includes('apiKeyEnv: CB_GATEWAY_API_KEY'));
check('没有 apiKey', !/^\s*apiKey:/mu.test(read()));

console.log('--- 4. 参数校验 ---');
check('地址不合法要拒', writeProvider({ gatewayBase: 'localhost:7801', credentialRef: 'X' }).ok === false);
check('缺引用名要拒', writeProvider({ gatewayBase: 'http://10.0.0.45:7801' }).ok === false);
check('引用名不合法要拒', writeProvider({ gatewayBase: 'http://10.0.0.45:7801', credentialRef: 'a-b' }).ok === false);

console.log('--- 5. 没有 provider 时新建 ---');
fs.writeFileSync(profile, ['- id: llm-pi-ai', '  config:', '    providers:', '- id: permission', ''].join('\n'), 'utf8');
const created = writeProvider({ gatewayBase: 'http://10.0.0.45:7801', credentialRef: 'CB_GATEWAY_API_KEY' });
check('action 是 created', created.ok === true && created.action === 'created');
const createdText = read();
check('新建了 qb provider', createdText.includes('qb:'));
check('写进了 baseURL', createdText.includes('baseURL: http://10.0.0.45:7801/v1'));
check('写的是 apiKeyEnv 而不是 apiKey', createdText.includes('apiKeyEnv: CB_GATEWAY_API_KEY') && !/^\s*apiKey:/mu.test(createdText));
check('api 是 openai-completions', createdText.includes('api: openai-completions'));

console.log('--- 6. profile 里没有 llm-pi-ai 要报错 ---');
fs.writeFileSync(profile, ['- id: permission', ''].join('\n'), 'utf8');
const missing = writeProvider({ gatewayBase: 'http://10.0.0.45:7801', credentialRef: 'CB_GATEWAY_API_KEY' });
check('报错而不是硬造顶层条目', missing.ok === false);
check('错误信息能指导用户', /llm-pi-ai/u.test(missing.error));

console.log('--- 7. 不把 v1 的按通道条目当目标 ---');
fs.writeFileSync(
  profile,
  [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      old:',
    '        baseURL: http://10.0.0.45:7801/workbuddy/v1',
    '        apiKeyEnv: OLD_KEY',
    '- id: permission',
    '',
  ].join('\n'),
  'utf8',
);
const legacy = inspectProvider();
check('路径不是 /v1 的条目不算目标', legacy.ok === true && legacy.found === false);
const legacyWrite = writeProvider({ gatewayBase: 'http://10.0.0.45:7801', credentialRef: 'CB_GATEWAY_API_KEY' });
check('于是新建一条 /v1', legacyWrite.ok === true && legacyWrite.action === 'created');
check('旧条目的引用没被改', read().includes('apiKeyEnv: OLD_KEY'));
check('旧条目的 baseURL 没被改', read().includes('http://10.0.0.45:7801/workbuddy/v1'));

console.log('--- 8. `providers: {}`（DSH 没有任何 provider 时写的就是这个）要能自动补齐 ---');
fs.writeFileSync(
  profile,
  [
    '- id: llm-pi-ai',
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    '  config:',
    '    providers: {}',
    '- id: permission',
    '',
  ].join('\n'),
  'utf8',
);
const emptyMap = writeProvider({ gatewayBase: 'http://10.0.0.45:7801', credentialRef: 'CB_GATEWAY_API_KEY' });
check('空映射不再报错，直接新建', emptyMap.ok === true && emptyMap.action === 'created');
const emptyMapText = read();
check('把 {} 换成了块形式', emptyMapText.includes('    providers:\n') && !emptyMapText.includes('providers: {}'));
check('qb 在 providers 下面（缩进 6）', /^ {6}qb:$/mu.test(emptyMapText));
check('字段缩进 8', /^ {8}baseURL: http:\/\/10\.0\.0\.45:7801\/v1$/mu.test(emptyMapText));
check('没有破坏后面的条目', emptyMapText.includes('- id: permission'));

console.log('--- 9. 连 providers: 键都没有，但有 config: ---');
fs.writeFileSync(
  profile,
  ['- id: llm-pi-ai', '  name: "@deepseek-ai/dsh-llm-pi-ai"', '  config:', '    defaultModel: x', '- id: permission', ''].join('\n'),
  'utf8',
);
const noProviders = writeProvider({ gatewayBase: 'http://10.0.0.45:7801', credentialRef: 'CB_GATEWAY_API_KEY' });
check('自动补 providers 段', noProviders.ok === true && noProviders.action === 'created');
const noProvidersText = read();
check('providers 加在 config 下', /^ {4}providers:$/mu.test(noProvidersText));
check('原有 config 字段保留', noProvidersText.includes('defaultModel: x'));
check('qb 写进去了', /^ {6}qb:$/mu.test(noProvidersText));

console.log('--- 10. 连 config: 都没有 ---');
fs.writeFileSync(profile, ['- id: llm-pi-ai', '  name: "@deepseek-ai/dsh-llm-pi-ai"', '- id: permission', ''].join('\n'), 'utf8');
const noConfig = writeProvider({ gatewayBase: 'http://10.0.0.45:7801', credentialRef: 'CB_GATEWAY_API_KEY' });
check('自动补 config + providers', noConfig.ok === true && noConfig.action === 'created');
const noConfigText = read();
check('config 补在 llm-pi-ai 下', /^ {2}config:$/mu.test(noConfigText));
check('providers 在 config 下', /^ {4}providers:$/mu.test(noConfigText));
check('qb 在 providers 下', /^ {6}qb:$/mu.test(noConfigText));
check('没有写到 permission 条目后面', noConfigText.indexOf('qb:') < noConfigText.indexOf('- id: permission'));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
process.exit(bad === 0 ? 0 : 1);
