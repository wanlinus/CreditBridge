import assert from 'node:assert/strict';
import { parseCallback } from '../src/channels/trae/login.ts';

const CODE = '_6u-tkXVHnykG_dINwsSrcl2JaIDqd5aheVAiIGJa98';

function callback(query) {
  const url = new URL('http://127.0.0.1:57348/authorize');
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url;
}

const cases = [
  {
    name: '现在客户端返回的 authCodeInfo（真实形状）',
    url: callback({
      isRedirect: 'true',
      scope: 'trae',
      authCodeInfo: JSON.stringify({ AuthCode: CODE, ExpireAt: 1794121272637, ExpireDuration: 600000 }),
      loginTraceID: 'ca22488c-3f3a-4989-a8ab-a7101c80866c',
      host: 'https://api.trae.com.cn',
      userRegion: 'cn',
      userInfo: JSON.stringify({
        UserID: '1234567890123456',
        ScreenName: '用户60869301709',
        Region: 'CN',
        TenantID: '7o2d894p7dr0o4',
      }),
    }),
    expect: { code: CODE, key: 'authCodeInfo', host: 'https://api.trae.com.cn', userId: '1234567890123456', username: '用户60869301709' },
  },
  {
    name: '老式裸参数 authCode',
    url: callback({ authCode: 'plain-auth-code' }),
    expect: { code: 'plain-auth-code', key: 'authCode', host: '', userId: '', username: '' },
  },
  {
    name: 'OAuth 标准 code',
    url: callback({ code: 'oauth-code' }),
    expect: { code: 'oauth-code', key: 'code', host: '', userId: '', username: '' },
  },
  {
    name: 'authCodeInfo 不是 JSON 时不能炸，也不能误判成有码',
    url: callback({ authCodeInfo: 'not-json' }),
    expect: null,
  },
  {
    name: 'authCodeInfo 里没有 AuthCode',
    url: callback({ authCodeInfo: JSON.stringify({ ExpireAt: 1 }) }),
    expect: null,
  },
  {
    name: '完全没带授权码',
    url: callback({ isRedirect: 'true' }),
    expect: null,
  },
  {
    name: 'host 不在白名单就丢掉（query 是浏览器可控的）',
    url: callback({
      authCodeInfo: JSON.stringify({ AuthCode: CODE }),
      host: 'https://evil.example.com',
    }),
    expect: { code: CODE, key: 'authCodeInfo', host: '', userId: '', username: '' },
  },
  {
    name: 'userInfo 坏了不影响取授权码',
    url: callback({ authCodeInfo: JSON.stringify({ AuthCode: CODE }), userInfo: '{oops' }),
    expect: { code: CODE, key: 'authCodeInfo', host: '', userId: '', username: '' },
  },
];

let failed = 0;
for (const item of cases) {
  const got = parseCallback(item.url);
  try {
    assert.deepEqual(got, item.expect);
    console.log(`  ok   ${item.name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${item.name}`);
    console.log(`       期望 ${JSON.stringify(item.expect)}`);
    console.log(`       实际 ${JSON.stringify(got)}`);
  }
}

console.log(failed === 0 ? `\n全部通过（${cases.length} 项）` : `\n${failed}/${cases.length} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
