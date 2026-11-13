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
