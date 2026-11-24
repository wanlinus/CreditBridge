// 验证 Qoder 令牌续期：用 drt- 换新 dt-，并把结果写回账号文件。
//
// **这是手工工具，不在 `npm test` 里。** 两个原因：
//   · 它会真的打上游——正常路径只在 `expiresAt` 前几分钟才续期，等自然触发要放到
//     一个月以后，没法确认这段代码到底对不对；
//   · 它读**真实**账号，并把续期结果**写回真实账号文件**。
// 2026-11-12 之前它挂在 `npm test` 链条上，只靠「没有 Qoder 账号就 exit 0」侥幸没出事：
// 一旦那台机器有号，跑一次 `npm test` 就会烧一次上游请求、并改掉真实凭据。
//
// 必须显式确认才真的执行（防误跑）：
//   node test/refresh-qoder.mjs --live        或 QB_LIVE_QODER_REFRESH=1
// 想拿副本试，就同时给 `QB_DATA_DIR=<临时目录>`：读写都走那个目录，不碰真实账号。
import fs from 'node:fs';
import path from 'node:path';

if (!(process.argv.includes('--live') || process.env.QB_LIVE_QODER_REFRESH === '1')) {
  console.log('跳过：这是会打上游、并写回真实账号文件的手工工具。');
  console.log('确认要跑就加 --live（或设 QB_LIVE_QODER_REFRESH=1）；想改在副本上试，再给 QB_DATA_DIR=<目录>。');
  process.exit(0);
}

const accounts = await import('../src/core/accounts.ts');
const { refreshQoderCredential } = await import('../src/channels/qoder/auth.ts');

accounts.loadAccounts();
const account = accounts.accountsOf('qoder')[0];
if (!account) {
  console.log('没有 Qoder 账号，跳过（去 /accounts 加一个再来）');
  process.exit(0);
}

const before = account.credential;
console.log('续期前:');
console.log('  dt- 到期   :', before.expiresAt);
console.log('  drt- 到期  :', before.refreshTokenExpiresAt);
console.log('  dt- 前缀   :', String(before.token || '').slice(0, 3), '长度', String(before.token || '').length);

let after;
try {
  after = await refreshQoderCredential(before);
} catch (error) {
  console.log('续期失败:', error.message);
  process.exit(1);
}

// 续期结果要落盘：只在内存里换掉，下一次进程重启又用回旧的，等于白刷。
accounts.updateAccount(account.id, { credential: after });
const stored = JSON.parse(fs.readFileSync(path.join(process.env.QB_DATA_DIR || path.join(import.meta.dirname, '..', 'data'), 'accounts', 'qoder', `${account.id}.json`), 'utf8')).credential;

console.log('\n续期后:');
console.log('  dt- 到期   :', after.expiresAt);
console.log('  drt- 到期  :', after.refreshTokenExpiresAt);
console.log('  dt- 前缀   :', String(after.token).slice(0, 3), '长度', String(after.token).length);

const problems = [];
if (after.token === before.token) problems.push('dt- 没有变，可能没真的续期');
if (!String(after.token).startsWith('dt-')) problems.push(`新令牌不是 dt- 开头：${String(after.token).slice(0, 6)}`);
if (!String(after.refreshToken || '').startsWith('drt-')) problems.push('新 refreshToken 不是 drt- 开头');
if (!after.expiresAt || Date.parse(after.expiresAt) <= Date.now()) problems.push('新 expiresAt 不合理');
if (stored.token !== after.token) problems.push('续期结果没有写回账号文件');
const days = (Date.parse(after.expiresAt) - Date.now()) / 86400000;
if (!(days > 7)) problems.push(`新令牌只剩 ${days.toFixed(1)} 天有效期，续期没起作用`);

if (problems.length > 0) {
  console.log('\nFAIL');
  for (const p of problems) console.log('  -', p);
  process.exitCode = 1;
} else {
  console.log(`\n全部通过（新令牌有效 ${days.toFixed(1)} 天）`);
}
