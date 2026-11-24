// 认证闸门的「死锁」回归测试。
//
// ## 为什么要单独一套
//
// 这类洞的共同点是：**只有从零部署才现形**，而且症状指向错误的方向——用户看到的是
// 「登录不了」或「改不了密」，而 `npm run check` 和其余测试全绿。
//
// 1. 2026-11-10：`passwordGate` 拦住 `/login` 自己 → 全新部署死锁（已修）
// 2. 2026-11-12：`POST /api/login` 不在 `PUBLIC_PATHS` 里 → SPA 登录永远 401
// 3. 2026-11-12：`POST /api/password` 被 `passwordGate` 拦住 → 新部署**永远改不了密**
// 4. 2026-11-13：SPA 转正，页面层消失——闸门只该管 `/api/*` 与 `/v1/*`，
//    前端产物（壳、静态资源、深链接）必须**无条件放行**，否则登录页自己加载不出来
//
// 判据是同一条：**「为了进门必须能调用的东西」不能在闸门后面**。
//
// 跑：node test/auth-deadlock.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-deadlock-'));
process.env.QB_DATA_DIR = tempData;

const mw = await import('../src/auth/middleware.ts');
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

/** 造一个最小的 Hono Context 替身，够中间件读 path/method 并判断「放行了没」。 */
function fakeContext(pathname, method = 'GET', headers = {}) {
  return {
    req: {
      path: pathname,
      method,
      url: `http://127.0.0.1:7801${pathname}`,
      header: (name) => headers[name.toLowerCase()] ?? headers[name] ?? undefined,
    },
    json: (body, status) => ({ kind: 'json', body, status }),
    redirect: (location, status) => ({ kind: 'redirect', location, status }),
    html: (body, status) => ({ kind: 'html', body, status }),
  };
}

async function runGate(gate, c) {
  let passed = false;
  const result = await gate(c, async () => {
    passed = true;
  });
  return { passed, result };
}

try {
  // 首次访问会懒创建默认凭据（admin/admin + mustChangePassword = true）
  auth.username();
  check('全新部署处于「未改密」状态', auth.mustChangePassword(), true);

  console.log('\n--- authGate：前端产物必须无条件放行 ---');
  // 壳和静态资源不含任何数据。拦住它们 = 登录页加载不出来 = 死锁。
  for (const p of ['/', '/login', '/password', '/accounts', '/accounts/wb-1', '/assets/index-abc.js']) {
    const { passed } = await runGate(mw.authGate, fakeContext(p));
    check(`${p} 放行（不需要凭据）`, passed, true);
  }

  console.log('\n--- authGate：为了拿到凭据必须先能打到的端点 ---');
  for (const [p, method] of [
    ['/api/login', 'POST'],
    ['/api/logout', 'POST'],
  ]) {
    const { passed } = await runGate(mw.authGate, fakeContext(p, method));
    check(`${method} ${p} 未登录时放行`, passed, true);
  }

  console.log('\n--- authGate：其余 API 必须拦住 ---');
  for (const p of ['/api/health', '/api/accounts', '/api/keys', '/v1/models']) {
    const { passed, result } = await runGate(mw.authGate, fakeContext(p));
    check(`${p} 未登录时拦住`, passed, false);
    // 一律 JSON 401：前端拿到它自己跳登录页，服务端不再 302。
    check(`  ${p} 回 JSON 401`, result?.status, 401);
  }

  console.log('\n--- passwordGate：未改密时必须放行的东西 ---');
  // 前端产物 + 三个进门端点。少任何一个，全新部署都会锁死。
  for (const [p, method] of [
    ['/', 'GET'],
    ['/login', 'GET'],
    ['/password', 'GET'],
    ['/accounts', 'GET'],
    ['/assets/index-abc.js', 'GET'],
    ['/api/login', 'POST'],
    ['/api/logout', 'POST'],
    ['/api/password', 'POST'],
  ]) {
    const { passed } = await runGate(mw.passwordGate, fakeContext(p, method));
    check(`${method} ${p} 未改密时放行`, passed, true);
  }

  console.log('\n--- passwordGate：改密之前其余 API 必须拦住 ---');
  {
    const { passed, result } = await runGate(mw.passwordGate, fakeContext('/api/health'));
    check('/api/health 被拦住', passed, false);
    check('  回 403 password_change_required', result?.status, 403);
    check('  错误类型正确', result?.body?.error?.type, 'password_change_required');
  }
  {
    const { passed } = await runGate(mw.passwordGate, fakeContext('/api/accounts'));
    check('/api/accounts 被拦住', passed, false);
  }

  console.log('\n--- 改密之后闸门放开 ---');
  const problem = auth.changePassword('admin', 'admin12345');
  check('改密成功', problem, null);
  check('mustChangePassword 变 false', auth.mustChangePassword(), false);
  {
    const { passed } = await runGate(mw.passwordGate, fakeContext('/api/health'));
    check('改密后 /api/health 放行', passed, true);
  }
} finally {
  // 先关库再删临时目录：Windows 上删不掉一个被打开的文件（EPERM）。
const { closeDb } = await import('../src/shared/db.ts');
closeDb();
fs.rmSync(tempData, { recursive: true, force: true });
}

console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
