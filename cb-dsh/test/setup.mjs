import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-full-'));
const profile = path.join(tmp, 'cordis.patch.yml');
const configDir = path.join(tmp, 'cb-dsh');
const PORT = 7891;

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
    '        baseURL: http://127.0.0.1:1/v1',
    '        models: []',
    '- id: permission',
    '',
  ].join('\n'),
  'utf8',
);

process.env.QB_DSH_PROFILE = profile;
process.env.QB_DSH_CONFIG_DIR = configDir;
process.env.QB_DSH_CONTROL_PORT = String(PORT);
process.env.QB_DSH_GATEWAY = 'http://127.0.0.1:1';

const stub = http.createServer((req, res) => {
  if (req.url === '/api/models' && req.headers.authorization === 'Bearer sk-GOOD') {
    const body = JSON.stringify({
      object: 'list',
      data: [
        { id: 'wb-1/hy4free', name: 'wb-1/Hy4 · 0.00x', context_length: 960000, max_output_tokens: 64000, input: ['text'] },
        { id: 'tr-1/glm-5.3', name: 'tr-1/GLM-5.3 · 0.08x', context_length: 200000, max_output_tokens: 32000, input: ['text'] },
      ],
    });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }
  res.writeHead(401, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'unauthorized', type: 'unauthorized' } }));
});
await new Promise((resolve) => stub.listen(7811, '127.0.0.1', resolve));

const stored = [];
const fakeCredentials = {
  async set(ref, value) {
    stored.push({ ref, value });
  },
};

let injectCb = null;
const ctx = {
  get: () => undefined,
  inject: (services, cb) => {
    if (services.includes('credentials')) injectCb = cb;
  },
  on() {},
};

const mod = await import('../lib/index.js');
mod.apply(ctx);
if (injectCb) injectCb({ get: () => fakeCredentials });
await new Promise((r) => setTimeout(r, 300));

let bad = 0;
const check = (name, ok) => {
  console.log((ok ? '  ✓ ' : '  ✗ ') + name);
  if (!ok) bad += 1;
};

const setup = async (body) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, doc: await res.json() };
};

console.log('--- 1. 正常保存 ---');
const ok1 = await setup({ gatewayBase: 'http://127.0.0.1:7811', apiToken: 'sk-GOOD' });
console.log('  ' + JSON.stringify({ status: ok1.status, ok: ok1.doc.ok, ref: ok1.doc.credentialRef, sync: ok1.doc.sync && ok1.doc.sync.ok }));
check('HTTP 200', ok1.status === 200);
check('ok 为真', ok1.doc.ok === true);
check('沿用了 JF_API_KEY', ok1.doc.credentialRef === 'JF_API_KEY');
check('凭据写进服务，且只有一次', stored.length === 1 && stored[0].ref === 'JF_API_KEY' && stored[0].value === 'sk-GOOD');
check('模型同步成功', ok1.doc.sync.ok === true && ok1.doc.sync.models === 2);

const after1 = fs.readFileSync(profile, 'utf8');
check('profile 的 baseURL 换了', after1.includes('baseURL: http://127.0.0.1:7811/v1'));
check('profile 写的是 apiKeyEnv', after1.includes('apiKeyEnv: JF_API_KEY'));
check('profile 里没有明文 key', !after1.includes('sk-GOOD'));
check('models 段写进去了', after1.includes('- id: wb-1/hy4free'));

console.log('--- 2. 配置落在临时目录（没碰真 config.json） ---');
const cfgPath = path.join(configDir, 'config.json');
check('临时目录里有 config.json', fs.existsSync(cfgPath));
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
check('config.json 是这次写的地址', cfg.gatewayBase === 'http://127.0.0.1:7811');
check('config.json 里有 key', cfg.apiToken === 'sk-GOOD');

console.log('--- 3. key 无效：保存仍成功，同步报失败 ---');
const ok2 = await setup({ gatewayBase: 'http://127.0.0.1:7811', apiToken: 'sk-BAD' });
console.log('  ' + JSON.stringify({ status: ok2.status, ok: ok2.doc.ok, sync: ok2.doc.sync && ok2.doc.sync.error }));
check('HTTP 200（不是 500）', ok2.status === 200);
check('ok 仍为真', ok2.doc.ok === true);
check('sync 报失败', ok2.doc.sync.ok === false);
check('错误里带 401', /401/u.test(String(ok2.doc.sync.error)));
check('凭据还是被存下了', stored.length === 2 && stored[1].value === 'sk-BAD');

console.log('--- 4. 参数校验 ---');
check('地址不合法回 400', (await setup({ gatewayBase: 'localhost:7801', apiToken: 'x' })).status === 400);
check('空 key 回 400', (await setup({ gatewayBase: 'http://127.0.0.1:7811', apiToken: '' })).status === 400);

console.log('--- 5. 没有 credentials 服务要回 500 并说清楚 ---');
const PORT2 = 7892;
process.env.QB_DSH_CONTROL_PORT = String(PORT2);
const mod2 = await import('../lib/index.js?bare=1');
mod2.apply({ get: () => undefined, inject: () => {}, on() {} });
await new Promise((r) => setTimeout(r, 300));
const bare = await fetch(`http://127.0.0.1:${PORT2}/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ gatewayBase: 'http://127.0.0.1:7811', apiToken: 'sk-X' }),
});
const bareDoc = await bare.json();
check('回 500', bare.status === 500);
check('提示里点名 credentials 服务', /credentials/u.test(String(bareDoc.error)));

stub.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
process.exit(bad === 0 ? 0 : 1);
