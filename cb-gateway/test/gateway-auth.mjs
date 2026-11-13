import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-gw-auth-'));
process.env.QB_DATA_DIR = tempData;

const auth = await import('../src/shared/gateway-auth.ts');

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

try {
  auth.username();
  const credPath = path.join(tempData, 'auth', 'gateway.json');
  check('数据目录用的是临时目录', tempData.startsWith(os.tmpdir()));
  check('默认账号创建成功', fs.existsSync(credPath));
  const stored = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  check('用户名是 admin', stored.username, 'admin');
  check('存的是哈希不是明文', stored.hash === 'admin' || stored.hash.includes('admin'), false);
  check('哈希是 64 字节 hex', /^[0-9a-f]{128}$/u.test(stored.hash));
  check('有独立的盐', /^[0-9a-f]{32}$/u.test(stored.salt));
  check('首次启动要求改密码', stored.mustChangePassword, true);
  check('新部署不生成 token 字段', stored.token === undefined);
  if (process.platform === 'win32') {
    console.log('  · 文件权限：Windows 靠 data/auth 目录的 ACL，不用 mode（跳过断言）');
  } else {
    check('文件权限是 600', (fs.statSync(credPath).mode & 0o777).toString(8), '600');
  }

  check('admin/admin 通过', auth.verifyPassword('admin', 'admin'), true);
  check('密码错被拒', auth.verifyPassword('admin', 'wrong'), false);
  check('用户名错被拒', auth.verifyPassword('root', 'admin'), false);

  check('取出 Bearer 的值', auth.extractBearer('Bearer abc123'), 'abc123');
  check('多余空白也认', auth.extractBearer('Bearer   abc123  '), 'abc123');
  check('没有前缀 → null', auth.extractBearer('abc123'), null);
  check('别的 scheme → null', auth.extractBearer('Basic abc123'), null);
  check('空头 → null', auth.extractBearer(undefined), null);
  check('大小写不敏感', auth.extractBearer('bearer abc123'), 'abc123');

  const sid = auth.createSession();
  check('新建会话有效', auth.sessionValid(sid), true);
  check('会话能从 Cookie 头里取回', auth.sessionFromCookie(`a=1; gw_session=${sid}; b=2`), sid);
  check('随便编的会话无效', auth.sessionValid('deadbeef'), false);
  auth.destroySession(sid);
  check('登出后会话失效', auth.sessionValid(sid), false);

  check('旧密码错 → 拒绝', auth.changePassword('wrong', 'newpass123'), '当前密码不对');
  check('新密码太短 → 拒绝', auth.changePassword('admin', '12345'), '新密码至少 6 位');
  check('以上都没改动文件', JSON.parse(fs.readFileSync(credPath, 'utf8')).mustChangePassword, true);

  check('改密码成功', auth.changePassword('admin', 'newpass123'), null);
  check('改完不再强制', auth.mustChangePassword(), false);
  check('旧密码失效', auth.verifyPassword('admin', 'admin'), false);
  check('新密码生效', auth.verifyPassword('admin', 'newpass123'), true);
  check('新旧相同 → 拒绝', auth.changePassword('newpass123', 'newpass123'), '新密码不能和当前密码相同');

  auth.resetForTests();
  check('重启后新密码仍有效', auth.verifyPassword('admin', 'newpass123'), true);
  check('重启后不要求改密码', auth.mustChangePassword(), false);

  fs.writeFileSync(credPath, '{ 这不是 JSON', 'utf8');
  auth.resetForTests();
  check('坏文件会重建出 admin/admin', auth.verifyPassword('admin', 'admin'), true);
  check('重建后重新要求改密码', auth.mustChangePassword(), true);
} finally {
  fs.rmSync(tempData, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}（${pass} 项通过，${fail} 项失败）`);
process.exitCode = fail === 0 ? 0 : 1;
