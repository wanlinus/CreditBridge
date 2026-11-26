// 守护网页登录态：默认账号、哈希存储、会话、强制改密。跑在临时目录，不碰真实凭据。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, section, done } from './_helpers.mjs';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-gw-auth-'));
process.env.QB_DATA_DIR = tempData;

const auth = await import('../src/shared/gateway-auth.ts');
const { db, closeDb } = await import('../src/shared/db.ts');

const credRow = () => db.prepare('SELECT * FROM gateway_credential WHERE id = 1').get();

section('1. 默认账号');
auth.username(); // loadCredential() 是懒的：不先调一次，库里不会有那一行
const stored = credRow();
check('数据目录用的是临时目录', tempData.startsWith(os.tmpdir()));
check('默认账号创建成功', stored !== undefined);
check('单行表的 id 恒为 1', stored.id, 1);
check('用户名是 admin', stored.username, 'admin');
check('存的是哈希不是明文', stored.hash === 'admin' || stored.hash.includes('admin'), false);
check('哈希是 64 字节 hex', /^[0-9a-f]{128}$/u.test(stored.hash));
check('有独立的盐', /^[0-9a-f]{32}$/u.test(stored.salt));
check('首次启动要求改密码（存成 1）', stored.must_change_password, 1);
check('新部署不生成 token 字段', 'token' in stored, false);

section('2. 密码校验');
const pwCases = [
  ['admin/admin 通过', 'admin', 'admin', true],
  ['密码错被拒', 'admin', 'wrong', false],
  ['用户名错被拒', 'root', 'admin', false],
];
for (const [name, user, pw, expected] of pwCases) check(name, auth.verifyPassword(user, pw), expected);

section('3. Bearer 解析');
const bearerCases = [
  ['取出 Bearer 的值', 'Bearer abc123', 'abc123'],
  ['多余空白也认', 'Bearer   abc123  ', 'abc123'],
  ['大小写不敏感', 'bearer abc123', 'abc123'],
  ['没有前缀 → null', 'abc123', null],
  ['别的 scheme → null', 'Basic abc123', null],
  ['空头 → null', undefined, null],
];
for (const [name, input, expected] of bearerCases) check(name, auth.extractBearer(input), expected);

section('4. 会话');
const sid = auth.createSession();
check('新建会话有效', auth.sessionValid(sid), true);
check('会话能从 Cookie 头里取回', auth.sessionFromCookie(`a=1; gw_session=${sid}; b=2`), sid);
check('随便编的会话无效', auth.sessionValid('deadbeef'), false);
auth.destroySession(sid);
check('登出后会话失效', auth.sessionValid(sid), false);

section('5. 改密码');
const rejectCases = [
  ['旧密码错 → 拒绝', 'wrong', 'newpass123', '当前密码不对'],
  ['新密码太短 → 拒绝', 'admin', '12345', '新密码至少 6 位'],
];
for (const [name, cur, next, expected] of rejectCases) check(name, auth.changePassword(cur, next), expected);
check('拒绝都没改动库', credRow().must_change_password, 1);

check('改密码成功', auth.changePassword('admin', 'newpass123'), null);
check('改完不再强制', auth.mustChangePassword(), false);
check('旧密码失效', auth.verifyPassword('admin', 'admin'), false);
check('新密码生效', auth.verifyPassword('admin', 'newpass123'), true);
// 放在改密成功之后：当前密码本身得够长，否则先被长度规则拦下
check('新旧相同 → 拒绝', auth.changePassword('newpass123', 'newpass123'), '新密码不能和当前密码相同');

section('6. 重启后从库读回');
auth.resetForTests();
check('重启后新密码仍有效', auth.verifyPassword('admin', 'newpass123'), true);
check('重启后不要求改密码', auth.mustChangePassword(), false);

closeDb();
fs.rmSync(tempData, { recursive: true, force: true });
done();
