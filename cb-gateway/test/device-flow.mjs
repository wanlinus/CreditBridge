import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-device-flow-'));
process.env.QB_DATA_DIR = tmp;

const { pkceChallenge, buildAuthorizeUrl, buildPollUrl, parsePollResponse } = await import(
  '../src/channels/qoder/device-flow.ts'
);

const cases = [];

{
  const { verifier, challenge } = pkceChallenge();
  const crypto = await import('node:crypto');
  const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
  cases.push(['PKCE challenge = sha256(verifier) base64url', challenge === expected]);
  cases.push(['PKCE verifier 是 base64url 且够长', /^[A-Za-z0-9_-]{40,}$/.test(verifier)]);
  const again = pkceChallenge();
  cases.push(['两次 PKCE 不重复', again.verifier !== verifier]);
}

{
  const url = new URL(buildAuthorizeUrl({ challenge: 'CH', nonce: 'N1', machineId: 'M1' }));
  cases.push(['授权 URL 域名是 qoder.cn', url.hostname === 'qoder.cn']);
  cases.push(['授权 URL 路径是 /device/selectAccounts', url.pathname === '/device/selectAccounts']);
  cases.push(['授权 URL 带 challenge', url.searchParams.get('challenge') === 'CH']);
  cases.push(['授权 URL 带 challenge_method=S256', url.searchParams.get('challenge_method') === 'S256']);
  cases.push(['授权 URL 带 nonce', url.searchParams.get('nonce') === 'N1']);
  cases.push(['授权 URL 带 machine_id', url.searchParams.get('machine_id') === 'M1']);
  cases.push(['授权 URL 带 client_id（CN 固定值）', url.searchParams.get('client_id') === 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb']);

  const withToken = new URL(buildAuthorizeUrl({ challenge: 'CH', nonce: 'N1', machineId: 'M1', machineToken: 'TOK123' }));
  cases.push(['授权 URL 带 machine_token（给了就带）', withToken.searchParams.get('machine_token') === 'TOK123']);
  const withoutToken = new URL(buildAuthorizeUrl({ challenge: 'CH', nonce: 'N1', machineId: 'M1' }));
  cases.push(['授权 URL 不带 machine_token（没给就省略）', withoutToken.searchParams.get('machine_token') === null]);
}

{
  const url = new URL(buildPollUrl({ nonce: 'N1', verifier: 'V1' }));
  cases.push(['轮询 URL 域名是 openapi.qoder.com.cn', url.hostname === 'openapi.qoder.com.cn']);
  cases.push(['轮询 URL 路径是 /api/v1/deviceToken/poll', url.pathname === '/api/v1/deviceToken/poll']);
  cases.push(['轮询 URL 带 nonce', url.searchParams.get('nonce') === 'N1']);
  cases.push(['轮询 URL 带 verifier', url.searchParams.get('verifier') === 'V1']);
  cases.push(['轮询 URL 带 challenge_method=S256', url.searchParams.get('challenge_method') === 'S256']);
  cases.push(['轮询 URL 不带 machine_id/client_id', url.searchParams.get('machine_id') === null && url.searchParams.get('client_id') === null]);
}

{
  const r1 = parsePollResponse({
    token: 'dt-abc',
    refresh_token: 'drt-xyz',
    expires_at: '2026-12-09T11:56:43Z',
    refresh_token_expires_at: '2027-11-04T11:56:43Z',
    user_id: 'u1',
    user_name: '示例用户',
  });
  cases.push(['poll 短字段 token → dt-', r1?.token === 'dt-abc']);
  cases.push(['poll refresh_token → drt-', r1?.refreshToken === 'drt-xyz']);
  cases.push(['poll expires_at 原样', r1?.expiresAt === '2026-12-09T11:56:43Z']);
  cases.push(['poll user_id/name', r1?.userId === 'u1' && r1?.username === '示例用户']);

  const r2 = parsePollResponse({ device_token: 'dt-long', refresh_token: 'drt-2' });
  cases.push(['device_token 长字段也要认', r2?.token === 'dt-long']);

  const r3 = parsePollResponse({ token: 'dt-3', expires_in: 3600 });
  cases.push(['expires_in 秒数 → ISO', r3?.expiresAt && Date.parse(r3.expiresAt) > Date.now()]);

  cases.push(['无 token → null', parsePollResponse({ refresh_token: 'drt-4' }) === null]);
  cases.push(['空对象 → null', parsePollResponse({}) === null]);
  cases.push(['非对象 → null', parsePollResponse('oops') === null]);
}

{
  const { STATE_DIR } = await import('../src/shared/paths.ts');
  cases.push(['STATE_DIR 指向临时目录下的 state', STATE_DIR === path.join(tmp, 'state')]);
}

let failed = 0;
for (const [name, ok] of cases) {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL ${name}`);
  }
}
console.log(failed === 0 ? `\n全部通过（${cases.length} 项）` : `\n${failed}/${cases.length} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
