import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-noconf-'));
const profile = path.join(tmp, 'cordis.patch.yml');
const configDir = path.join(tmp, 'cb-dsh');
const PORT = 7892;

fs.writeFileSync(profile, ['- id: llm-pi-ai', '  config:', '    providers:', '      jf:', '        baseURL: http://127.0.0.1:1/v1', '        models: []', ''].join('\n'), 'utf8');

process.env.QB_DSH_PROFILE = profile;
process.env.QB_DSH_CONFIG_DIR = configDir;
process.env.QB_DSH_CONTROL_PORT = String(PORT);
process.env.QB_DSH_GATEWAY = 'http://127.0.0.1:1';

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

const ctx = { get: () => undefined, inject: () => {}, on() {} };
const mod = await import('../lib/index.js');
mod.apply(ctx);
await new Promise((r) => setTimeout(r, 250));

const call = async (pathname, init) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, init);
  return { status: res.status, doc: await res.json() };
};

console.log('--- 1. 全新安装（没有任何配置）---');
const fresh = await call('/config');
check('配置接口 200', fresh.status, 200);
check('configured 为 false', fresh.doc.configured, false);
check('storedBase 为空（不是兜底地址）', fresh.doc.storedBase, '');
check('gatewayBase 仍是兜底值（面板要能预填）', fresh.doc.gatewayBase, 'http://127.0.0.1:1');

const syncSkip = await call('/model-sync', { method: 'POST' });
check('手动同步返回 configured:false', syncSkip.doc.configured, false);
check('手动同步 ok 为 false', syncSkip.doc.ok, false);
check('原因说「还没配置」而不是网络错误', /还没配置/u.test(String(syncSkip.doc.error || '')), true);

const syncState = await call('/model-sync');
check('状态里也是 configured:false', syncState.doc.state && syncState.doc.state.configured, false);

console.log('\n--- 2. 只配了一半 ---');
const halfBase = await call('/config', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ gatewayBase: 'http://127.0.0.1:7811' }),
});
check('只给地址：configured 仍为 false', halfBase.doc.configured, false);

const halfToken = await call('/config', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ apiToken: '' }),
});
check('把 key 清空：configured 仍为 false', halfToken.doc.configured, false);

console.log('\n--- 3. 两项都配齐 ---');
const full = await call('/config', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ gatewayBase: 'http://127.0.0.1:7811', apiToken: 'sk-TEST' }),
});
check('configured 翻成 true', full.doc.configured, true);

const reread = await call('/config');
check('读回来 configured 仍是 true', reread.doc.configured, true);
check('storedBase 记下来了', reread.doc.storedBase, 'http://127.0.0.1:7811');

const syncTry = await call('/model-sync', { method: 'POST' });
check('配好之后同步不再报「还没配置」', /还没配置/u.test(String(syncTry.doc.error || '')), false);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
