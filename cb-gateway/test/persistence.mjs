// 守护落盘静默失败：原子写、config.json 单一写入口、凭据错误的「永久/暂时」区分。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, section, done } from './_helpers.mjs';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-persistence-'));
process.env.QB_DATA_DIR = tempData;

const atomic = await import('../src/shared/atomic-write.ts');
const configMod = await import('../src/config.ts');
const vis = await import('../src/shared/model-visibility.ts');
const credErrors = await import('../src/shared/credential-error.ts');
const accounts = await import('../src/core/accounts.ts');
const keys = await import('../src/core/keys.ts');
const { db, closeDb } = await import('../src/shared/db.ts');

const tmpCount = (dir) => fs.readdirSync(dir).filter((n) => n.includes('.tmp-')).length;

section('1. 原子写');
const target = path.join(tempData, 'atomic', 'demo.json');
atomic.writeFileAtomic(target, '{"a":1}\n');
check('写进去的内容能读回来', JSON.parse(fs.readFileSync(target, 'utf8')).a, 1);
check('不留临时文件', tmpCount(path.dirname(target)), 0);

atomic.writeFileAtomic(target, '{"a":2}\n');
check('覆盖写生效', JSON.parse(fs.readFileSync(target, 'utf8')).a, 2);

const nested = path.join(tempData, 'atomic', 'deep', 'dir', 'x.json');
atomic.writeFileAtomic(nested, 'ok');
check('父目录不存在时自动建', fs.readFileSync(nested, 'utf8'), 'ok');

// 深层路径也要能写成功，且不留垃圾
const deep = path.join(tempData, 'atomic', 'blocked', 'sub', 'y.json');
atomic.writeFileAtomic(deep, 'x');
check('深层路径也能写（不该抛）', fs.readFileSync(deep, 'utf8'), 'x');
check('写成功后目录里没有残留 tmp', tmpCount(path.dirname(deep)), 0);

section('2. config.json 单一写入口');
// 2026-11-11 的 bug 是「可见性」和「签到时间」各写一遍 config.json，谁后写谁赢。
// v4 后可见性进库，这里钉三件事：① 写可见性不碰 config.json；② 改签到时间不丢手写键；
// ③ host/port 不写回文件（只认 QB_HOST/QB_PORT，见 config.ts 的 FILE_KEYS）。
const configPath = path.join(tempData, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({ host: '0.0.0.0', port: 7801, defaultContextWindow: 111000 }, null, 2));

vis.setVisibleFor('wb', ['hy4free']);
vis.setListed('tr', false);
let doc = JSON.parse(fs.readFileSync(configPath, 'utf8'));
check('写可见性不碰 config.json', doc, { host: '0.0.0.0', port: 7801, defaultContextWindow: 111000 });
check('可见性确实写进库了', vis.visibleFor('wb'), ['hy4free']);
check('总闸确实写进库了', vis.isListed('tr'), false);

configMod.updateConfig({ checkinTime: '08:30' });
doc = JSON.parse(fs.readFileSync(configPath, 'utf8'));
check('签到时间写进去了', doc.checkinTime, '08:30');
check('手写的 defaultContextWindow 保留', doc.defaultContextWindow, 111000);
check('host 不写回文件', 'host' in doc, false);
check('port 不写回文件', 'port' in doc, false);
check('改签到时间不动可见性', vis.visibleFor('wb'), ['hy4free']);

// 反过来：先改签到时间，再写可见性，两边都不该互相覆盖
configMod.updateConfig({ checkinTime: '07:15' });
vis.setVisibleFor('tr', ['glm-5.3']);
doc = JSON.parse(fs.readFileSync(configPath, 'utf8'));
check('写可见性后 checkinTime 还在', doc.checkinTime, '07:15');
check('两个通道的可见性互不覆盖', vis.visibleModels(), { wb: ['hy4free'], tr: ['glm-5.3'] });

section('3. 凭据错误：永久 vs 暂时');
const expired = credErrors.credentialExpired('refreshToken 过期');
const unavailable = credErrors.credentialUnavailable('连接超时');
check('expired 是 permanent', expired.permanent, true);
check('unavailable 不是 permanent', unavailable.permanent, false);
check('两者都是 502', [expired.status, unavailable.status], [502, 502]);
check('expired 的错误码', expired.code, 'credential_expired');
check('unavailable 的错误码', unavailable.code, 'credential_unavailable');
check('isCredentialError 认得出', credErrors.isCredentialError(expired), true);
check('普通 Error 不算', credErrors.isCredentialError(new Error('x')), false);

const wrapped = credErrors.asCredentialError(expired, 'WorkBuddy 凭据不可用');
check('包装后仍保留 permanent（丢了就又变成「永远就绪」）', wrapped.permanent, true);
check('包装后带上通道前缀', wrapped.message, 'WorkBuddy 凭据不可用：refreshToken 过期');
check('非凭据错误包装返回 null', credErrors.asCredentialError(new Error('x')), null);

section('4. 账号落库');
accounts.loadAccounts();
const created = accounts.addAccount({ channelId: 'workbuddy', idPrefix: 'wb', credential: { accessToken: 'tok' }, label: '测试号' });
check('账号落库后能读回', db.prepare('SELECT label FROM account WHERE id = ?').get(created.id)?.label, '测试号');
check('凭据以 JSON 文本存一列', JSON.parse(db.prepare('SELECT credential FROM account WHERE id = ?').get(created.id).credential).accessToken, 'tok');
check('重新加载能找到这个号', accounts.loadAccounts().some((a) => a.id === created.id), true);

section('5. key 落库');
keys.resetKeysForTests();
const key = keys.createKey('测试');
check('key 落库后能校验', keys.verifyKey(key.secret) !== null, true);

closeDb();
fs.rmSync(tempData, { recursive: true, force: true });
done();
