import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-persistence-'));
process.env.QB_DATA_DIR = tempData;

const atomic = await import('../src/shared/atomic-write.ts');
const configMod = await import('../src/config.ts');
const vis = await import('../src/shared/model-visibility.ts');
const credErrors = await import('../src/shared/credential-error.ts');
const accounts = await import('../src/core/accounts.ts');
const keys = await import('../src/core/keys.ts');

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

console.log('--- 1. 原子写 ---');
const target = path.join(tempData, 'atomic', 'demo.json');
atomic.writeFileAtomic(target, '{"a":1}\n');
check('写进去的内容能读回来', JSON.parse(fs.readFileSync(target, 'utf8')).a, 1);
check('不留临时文件', fs.readdirSync(path.dirname(target)).filter((n) => n.includes('.tmp-')).length, 0);

atomic.writeFileAtomic(target, '{"a":2}\n');
check('覆盖写生效', JSON.parse(fs.readFileSync(target, 'utf8')).a, 2);

const nested = path.join(tempData, 'atomic', 'deep', 'dir', 'x.json');
atomic.writeFileAtomic(nested, 'ok');
check('父目录不存在时自动建', fs.readFileSync(nested, 'utf8'), 'ok');

const blocked = path.join(tempData, 'atomic', 'blockeddir');
fs.mkdirSync(blocked, { recursive: true });
let threw = false;
try {
  atomic.writeFileAtomic(path.join(blocked, 'sub', 'y.json'), 'x');
} catch {
  threw = true;
}
check('深层路径也能写（不该抛）', threw, false);
check('写成功后目录里没有残留 tmp', fs.readdirSync(path.join(blocked, 'sub')).filter((n) => n.includes('.tmp-')).length, 0);

console.log('\n--- 2. config.json 单一写入口 ---');
const configPath = path.join(tempData, 'config.json');

vis.setVisibleFor('wb', ['hy4free']);
vis.setListed('tr', false);
let doc = JSON.parse(fs.readFileSync(configPath, 'utf8'));
check('可见性写进去了', doc.visibleModels.wb, ['hy4free']);
check('总闸写进去了', doc.visibleChannels.tr, false);

configMod.updateConfig({ checkinTime: '08:30' });
doc = JSON.parse(fs.readFileSync(configPath, 'utf8'));
check('改签到时间后 visibleModels 还在（曾经会被整段抹掉）', doc.visibleModels.wb, ['hy4free']);
check('改签到时间后 visibleChannels 还在', doc.visibleChannels.tr, false);
check('签到时间确实写进去了', doc.checkinTime, '08:30');

configMod.updateConfig({ checkinTime: '07:15' });
vis.setVisibleFor('tr', ['glm-5.3']);
doc = JSON.parse(fs.readFileSync(configPath, 'utf8'));
check('存可见性后 checkinTime 还在', doc.checkinTime, '07:15');
check('两个通道的可见性互不覆盖', doc.visibleModels, { wb: ['hy4free'], tr: ['glm-5.3'] });

fs.writeFileSync(configPath, JSON.stringify({ host: '0.0.0.0', port: 7801, visibleModels: { wb: ['a'] } }, null, 2));
configMod.updateConfig({ checkinTime: '06:00' });
doc = JSON.parse(fs.readFileSync(configPath, 'utf8'));
check('手写的 host 保留', doc.host, '0.0.0.0');
check('手写的 port 保留', doc.port, 7801);

console.log('\n--- 3. 凭据错误分类 ---');
const expired = credErrors.credentialExpired('refreshToken 过期');
const unavailable = credErrors.credentialUnavailable('连接超时');
check('expired 是 permanent', expired.permanent, true);
check('unavailable 不是 permanent', unavailable.permanent, false);
check('两者都是 502（路由层按状态码回响应）', [expired.status, unavailable.status], [502, 502]);
check('expired 的错误码', expired.code, 'credential_expired');
check('unavailable 的错误码', unavailable.code, 'credential_unavailable');
check('isCredentialError 认得出', credErrors.isCredentialError(expired), true);
check('普通 Error 不算', credErrors.isCredentialError(new Error('x')), false);

const wrapped = credErrors.asCredentialError(expired, 'WorkBuddy 凭据不可用');
check('包装后仍保留 permanent（丢了就又变成「永远就绪」）', wrapped.permanent, true);
check('包装后带上通道前缀', wrapped.message, 'WorkBuddy 凭据不可用：refreshToken 过期');
check('非凭据错误包装返回 null', credErrors.asCredentialError(new Error('x')), null);

console.log('\n--- 4. 账号落盘 ---');
accounts.loadAccounts();
const created = accounts.addAccount({ channelId: 'workbuddy', idPrefix: 'wb', credential: { accessToken: 'tok' }, label: '测试号' });
check('账号落盘后能读回', JSON.parse(fs.readFileSync(path.join(tempData, 'accounts', 'workbuddy', `${created.id}.json`), 'utf8')).label, '测试号');
check('账号目录里没有残留 tmp', fs.readdirSync(path.join(tempData, 'accounts', 'workbuddy')).filter((n) => n.includes('.tmp-')).length, 0);
const reloaded = accounts.loadAccounts();
check('重新加载能找到这个号', reloaded.some((a) => a.id === created.id), true);

keys.resetKeysForTests();
const key = keys.createKey('测试');
check('key 落盘后能校验', keys.verifyKey(key.secret) !== null, true);
check('auth 目录里没有残留 tmp', fs.readdirSync(path.join(tempData, 'auth')).filter((n) => n.includes('.tmp-')).length, 0);

console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
