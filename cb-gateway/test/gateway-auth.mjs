// 网页登录态的自测：默认账号、密码哈希、会话、强制改密。
//
// **所有用例都跑在临时目录里**（QB_DATA_DIR），绝不碰真实的库里那份凭据
// ——否则跑一次测试就把用户的网关密码重置成 admin/admin 了。
//
// v4 起凭据进库（`gateway_credential` 单行表），所以断言查库，不查文件。
//
// API key 的校验不在这一份里，见 `test/keys.mjs`。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-gw-auth-'));
process.env.QB_DATA_DIR = tempData;

const auth = await import('../src/shared/gateway-auth.ts');
const { db, closeDb } = await import('../src/shared/db.ts');

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

const credRow = () => db.prepare('SELECT * FROM gateway_credential WHERE id = 1').get();

try {
  // ---- 首次启动创建默认账号 ----
  // loadCredential() 是懒的：不先调一次，库里不会有那一行。
  auth.username();
  check('数据目录用的是临时目录', tempData.startsWith(os.tmpdir()));
  const stored = credRow();
  check('默认账号创建成功', stored !== undefined);
  check('单行表的 id 恒为 1', stored.id, 1);
  check('用户名是 admin', stored.username, 'admin');
  check('存的是哈希不是明文', stored.hash === 'admin' || stored.hash.includes('admin'), false);
  check('哈希是 64 字节 hex', /^[0-9a-f]{128}$/u.test(stored.hash));
  check('有独立的盐', /^[0-9a-f]{32}$/u.test(stored.salt));
  check('首次启动要求改密码（存成 1）', stored.must_change_password, 1);
  // v2 起机器凭据只有 API key，表里没有明文 token 列。
  check('新部署不生成 token 字段', 'token' in stored, false);
  // 权限断言删掉了：凭据从文件搬进库之后，「gateway.json 必须是 600」不再有意义，
  // 库文件的 mode 由 umask 决定、真正的边界是 `data/` 目录的 ACL
  // （见 `shared/data-permissions.ts`）。留着断言只会测一个没人用的参数。

  // ---- 密码校验 ----
  check('admin/admin 通过', auth.verifyPassword('admin', 'admin'), true);
  check('密码错被拒', auth.verifyPassword('admin', 'wrong'), false);
  check('用户名错被拒', auth.verifyPassword('root', 'admin'), false);

  // ---- Bearer 解析 ----
  check('取出 Bearer 的值', auth.extractBearer('Bearer abc123'), 'abc123');
  check('多余空白也认', auth.extractBearer('Bearer   abc123  '), 'abc123');
  check('没有前缀 → null', auth.extractBearer('abc123'), null);
  check('别的 scheme → null', auth.extractBearer('Basic abc123'), null);
  check('空头 → null', auth.extractBearer(undefined), null);
  check('大小写不敏感', auth.extractBearer('bearer abc123'), 'abc123');

  // ---- 会话 ----
  const sid = auth.createSession();
  check('新建会话有效', auth.sessionValid(sid), true);
  check('会话能从 Cookie 头里取回', auth.sessionFromCookie(`a=1; gw_session=${sid}; b=2`), sid);
  check('随便编的会话无效', auth.sessionValid('deadbeef'), false);
  auth.destroySession(sid);
  check('登出后会话失效', auth.sessionValid(sid), false);

  // ---- 改密码的各种拒绝 ----
  check('旧密码错 → 拒绝', auth.changePassword('wrong', 'newpass123'), '当前密码不对');
  check('新密码太短 → 拒绝', auth.changePassword('admin', '12345'), '新密码至少 6 位');
  check('以上都没改动库', credRow().must_change_password, 1);

  // ---- 改密码成功 ----
  check('改密码成功', auth.changePassword('admin', 'newpass123'), null);
  check('改完不再强制', auth.mustChangePassword(), false);
  check('旧密码失效', auth.verifyPassword('admin', 'admin'), false);
  check('新密码生效', auth.verifyPassword('admin', 'newpass123'), true);
  // 这条要放在改密成功之后测：当前密码本身得满足长度，否则先被长度规则拦下。
  check('新旧相同 → 拒绝', auth.changePassword('newpass123', 'newpass123'), '新密码不能和当前密码相同');

  // ---- 重启后从库读回来 ----
  auth.resetForTests();
  check('重启后新密码仍有效', auth.verifyPassword('admin', 'newpass123'), true);
  check('重启后不要求改密码', auth.mustChangePassword(), false);

  // ---- 「文件损坏时按首次启动重建」这一组已经删掉 ----
  //
  // 进库之前这里塞半截 JSON，验证「坏文件 → 重建 admin/admin」。SQLite 给不出半行，
  // 而那个「重建」行为本身是**危险**的（等于把密码静默重置成默认值）；现在凭据只有
  // 一行、写入走事务，没有「文件坏了」这个状态了。
} finally {
  // 先关库再删临时目录：Windows 上删不掉一个被打开的文件（EPERM）。
  closeDb();
  fs.rmSync(tempData, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}（${pass} 项通过，${fail} 项失败）`);
process.exitCode = fail === 0 ? 0 : 1;
