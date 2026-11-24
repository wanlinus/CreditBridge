/**
 * COSY 签名器的回归测试。
 *
 * ## 分四层，故意分开
 *
 * 卡住时能立刻知道是哪一层的问题——这个模块调试成本很高（混淆代码 + wasm），
 * 混在一起的报错根本定位不了。
 *
 * | 层 | 验什么 | 需要网络 |
 * |---|---|---|
 * | 1 | 提取产物齐全、每个片段自身语法合法 | 否 |
 * | 2 | wasm 结构（导出齐全、import 来源正确） | 否 |
 * | 3 | 能实例化、能拿到 QoderContext / 现算 runtime fields | 否 |
 * | 4 | 现算的 `{encrypt_user_info, key}` 形状正确 | 否 |
 *
 * 真实联网验证在 `qoder-cosy-live.mjs` / `qoder-upstream-live.mjs`。
 *
 * ## 这里钉住的最重要一条
 *
 * **每个切片片段自身必须是合法 JS。** 切错边界时（比如少抄一个闭包收尾的 `)`），
 * 错误会在拼装后报在 6000 字符之外的位置，`missing ) after argument list`，
 * 极难定位。这一行测试能把它挡在源头。
 */
import fs from 'node:fs';
import path from 'node:path';

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

const COSY_DIR = path.join(import.meta.dirname, '..', 'src', 'channels', 'qoder', 'cosy');

/* ============================================================ 1. 提取产物 */

console.log('--- 1. 提取产物 ---');
const FILES = ['qoder_auth_wasm_bg.wasm', 'glue.mjs', 'helpers.mjs', 'exports.mjs', 'imports-object.mjs', 'extract-report.json'];
for (const f of FILES) check(`${f} 存在`, fs.existsSync(path.join(COSY_DIR, f)));

const wasmBytes = fs.readFileSync(path.join(COSY_DIR, 'qoder_auth_wasm_bg.wasm'));
check('wasm 魔数', wasmBytes.subarray(0, 4).toString('hex'), '0061736d');
check('wasm 大小 300-400KB', wasmBytes.length > 300_000 && wasmBytes.length < 400_000);

const glueText = fs.readFileSync(path.join(COSY_DIR, 'glue.mjs'), 'utf8');
const helpersText = fs.readFileSync(path.join(COSY_DIR, 'helpers.mjs'), 'utf8');
const exportsText = fs.readFileSync(path.join(COSY_DIR, 'exports.mjs'), 'utf8');
const importsText = fs.readFileSync(path.join(COSY_DIR, 'imports-object.mjs'), 'utf8');

check('glue 非空', glueText.length > 5000);
check('helpers 非空', helpersText.length > 1000);
check('exports 非空', exportsText.length > 3000);
check('imports 对象非空', importsText.length > 2000);

// **每个片段自身合法** —— 这条防止切片边界算错
for (const [name, text] of [['glue', glueText], ['helpers', helpersText], ['exports', exportsText]]) {
  let ok = true;
  try {
    new Function(text);
  } catch {
    ok = false;
  }
  check(`${name} 片段自身语法正确`, ok);
}

// `Mel`（wasm 初始化入口）含 `import.meta`，在 new Function 里不合法，必须排除
check('glue/exports 里没有 import.meta', /import\s*\.\s*meta/.test(glueText + exportsText), false);

// 值堆管理三件套必须在——缺了会在构造时抛 `RmA is not defined`
for (const fn of ['function Mw(', 'function eB(', 'function RmA(']) {
  check(`helpers 含 ${fn.slice(9, -1)}`, helpersText.includes(fn));
}

/* ========================================================= 2. wasm 结构 */

console.log('\n--- 2. wasm 结构 ---');
const mod = new WebAssembly.Module(wasmBytes);
const exportNames = WebAssembly.Module.exports(mod).map((e) => e.name);
const importMods = WebAssembly.Module.imports(mod);

check('导出 qodercontext_new', exportNames.includes('qodercontext_new'));
check('导出 qodercontext_prepareRequest', exportNames.includes('qodercontext_prepareRequest'));
check('导出 qodercontext_prepareInferRequest', exportNames.includes('qodercontext_prepareInferRequest'));
check('导出 generate_runtime_auth_fields', exportNames.includes('generate_runtime_auth_fields'));
check('导出 credential_storage_decrypt', exportNames.includes('credential_storage_decrypt'));
check('导出 decrypt_server_response', exportNames.includes('decrypt_server_response'));
check('import 全部来自 qoder_auth_wasm_bg.js', importMods.every((i) => i.module === './qoder_auth_wasm_bg.js'));
check('import 数量 31', importMods.length, 31);

/* ====================================================== 3. 模块可执行 */

console.log('\n--- 3. 模块可执行 ---');
const cosy = await import('../src/channels/qoder/cosy/index.ts');

let runtime = null;
try {
  runtime = await cosy.getCosyRuntime();
  check('初始化成功', runtime !== null);
  check('拿到 QoderContext', typeof runtime.QoderContext, 'function');
  check('拿到 credentialStorageDecrypt', typeof runtime.credentialStorageDecrypt, 'function');
  check('拿到 generateRuntimeAuthFields', typeof runtime.generateRuntimeAuthFields, 'function');
} catch (e) {
  check(`初始化失败：${e.message.slice(0, 160)}`, false);
}

check('导出了 COSY_VERSION', typeof cosy.COSY_VERSION, 'string');
check('导出了 DEFAULT_ENDPOINT', typeof cosy.DEFAULT_ENDPOINT, 'string');
check('端点指向 qoder 网关', cosy.DEFAULT_ENDPOINT.includes('gateway.qoder.com.cn'));

/* ====================================== 4. 现算 runtime fields（登录的核心） */

console.log('\n--- 4. deriveRuntimeFields（替代 CLI 登录的关键）---');
if (runtime) {
  // 用假 token 只验「形状」，不验「上游认不认」——后者在 live 测试里
  const fake = await cosy.deriveRuntimeFields({
    uid: '00000000-0000-0000-0000-000000000000',
    token: 'dt-fake-token-for-shape-test',
    dataPolicyAgreed: true,
  });
  check('返回了 uid', fake.uid, '00000000-0000-0000-0000-000000000000');
  check('返回了 encrypt_user_info', typeof fake.encrypt_user_info, 'string');
  check('返回了 key', typeof fake.key, 'string');
  // 172 字节是上游真实值的长度。**长度不对签名必然过不了**，
  // 而且只表现为 `Signature invalid`，看不出是输入少字段导致的。
  check('encrypt_user_info 是 172 字节（和真实值同长）', fake.encrypt_user_info.length, 172);
  check('key 是 172 字节', fake.key.length, 172);

  // 输入多带 organization_id 会让输出长度变化 → 签名直接失效。
  // 这条钉住「deriveRuntimeFields 只用三个字段」。
  //
  // 注意比的是**长度变化**而不是绝对值：绝对值取决于 uid/token 的长度，
  // 换一个账号数就不同。唯一稳定的事实是「多传一个字段，长度就变」。
  const withOrg = JSON.parse(
    runtime.generateRuntimeAuthFields(
      JSON.stringify({
        uid: '00000000-0000-0000-0000-000000000000',
        security_oauth_token: 'dt-fake-token-for-shape-test',
        data_policy_agreed: true,
        organization_id: '',
      }),
    ),
  );
  check(
    '多带 organization_id 会改变输出长度（说明不能多传）',
    withOrg.encrypt_user_info.length !== fake.encrypt_user_info.length,
    true,
  );
}

console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
