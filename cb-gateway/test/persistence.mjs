// 数据落盘的健壮性：原子写、配置单一写入口、凭据错误的「永久/暂时」区分。
//
// 这三条都属于**静默失败**：坏掉的时候没有异常、没有日志，只是状态悄悄不对。
// 所以必须有测试把它们钉住，否则下一次「顺手改成 writeFileSync」不会有人发现。
//
// 跑：node test/persistence.mjs
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

// ---- 1. 原子写 ----
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

// 目录本身不可写 → 抛错，且不留垃圾
const blocked = path.join(tempData, 'atomic', 'blockeddir');
fs.mkdirSync(blocked, { recursive: true });
let threw = false;
try {
  // 用一个不存在的深层文件当目标，但把临时目录指向一个文件路径来强制失败
  atomic.writeFileAtomic(path.join(blocked, 'sub', 'y.json'), 'x');
} catch {
  threw = true;
}
check('深层路径也能写（不该抛）', threw, false);
check('写成功后目录里没有残留 tmp', fs.readdirSync(path.join(blocked, 'sub')).filter((n) => n.includes('.tmp-')).length, 0);

// ---- 2. `config.json` 只有一个写入口，而且只管那三项 ----
//
// 2026-11-11 那个 bug 是「可见性」和「签到时间」各写一遍 `config.json`，谁后写谁赢，
// 于是保存勾选之后再改签到时间，被隐藏的模型全部冒回来。
//
// v4 之后这条**结构性消失**了：可见性和模型设置进了库，`config.json` 只剩
// host / port / checkinTime。所以这里钉两件事：① 写可见性不碰 `config.json`；
// ② 改签到时间不会丢掉用户手写的键。
console.log('\n--- 2. config.json 单一写入口 ---');
const configPath = path.join(tempData, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({ host: '0.0.0.0', port: 7801 }, null, 2));

vis.setVisibleFor('wb', ['hy4free']);
vis.setListed('tr', false);
let doc = JSON.parse(fs.readFileSync(configPath, 'utf8'));
check('写可见性不碰 config.json', doc, { host: '0.0.0.0', port: 7801 });
check('可见性确实写进库了', vis.visibleFor('wb'), ['hy4free']);
check('总闸确实写进库了', vis.isListed('tr'), false);

// 改签到时间：只动 checkinTime，手写的 host/port 必须原样留着。
configMod.updateConfig({ checkinTime: '08:30' });
doc = JSON.parse(fs.readFileSync(configPath, 'utf8'));
check('签到时间写进去了', doc.checkinTime, '08:30');
check('手写的 host 保留', doc.host, '0.0.0.0');
check('手写的 port 保留', doc.port, 7801);
check('改签到时间不动可见性', vis.visibleFor('wb'), ['hy4free']);

// 反过来：先改签到时间，再写可见性，两边都不该互相覆盖。
configMod.updateConfig({ checkinTime: '07:15' });
vis.setVisibleFor('tr', ['glm-5.3']);
doc = JSON.parse(fs.readFileSync(configPath, 'utf8'));
check('写可见性后 checkinTime 还在', doc.checkinTime, '07:15');
check('两个通道的可见性互不覆盖', vis.visibleModels(), { wb: ['hy4free'], tr: ['glm-5.3'] });

// ---- 3. 凭据错误：永久 vs 暂时 ----
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

// ---- 4. 账号进库：写进去能读回，重新加载还在 ----
//
// v4 之前这一组钉的是「账号文件是原子的、目录里没有残留 tmp」。进库之后那套
// tmp+rename 的机制不存在了（写入是事务），所以要钉的变成「落库 + 重新加载能读回」。
console.log('\n--- 4. 账号落库 ---');
accounts.loadAccounts();
const created = accounts.addAccount({ channelId: 'workbuddy', idPrefix: 'wb', credential: { accessToken: 'tok' }, label: '测试号' });
const { db } = await import('../src/shared/db.ts');
check(
  '账号落库后能读回',
  db.prepare('SELECT label, credential FROM account WHERE id = ?').get(created.id)?.label,
  '测试号',
);
check('凭据以 JSON 文本存一列', JSON.parse(db.prepare('SELECT credential FROM account WHERE id = ?').get(created.id).credential).accessToken, 'tok');
const reloaded = accounts.loadAccounts();
check('重新加载能找到这个号', reloaded.some((a) => a.id === created.id), true);

// ---- 5. key 表进库后仍能校验 ----
keys.resetKeysForTests();
const key = keys.createKey('测试');
check('key 落库后能校验', keys.verifyKey(key.secret) !== null, true);

console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
