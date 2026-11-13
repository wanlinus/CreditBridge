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
  auth.username();
  check('全新部署处于「未改密」状态', auth.mustChangePassword(), true);

  console.log('\n--- authGate：前端产物必须无条件放行 ---');
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
    check(`  ${p} 回 JSON 401`, result?.status, 401);
  }

  console.log('\n--- passwordGate：未改密时必须放行的东西 ---');
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
  fs.rmSync(tempData, { recursive: true, force: true });
}

console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
