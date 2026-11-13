import assert from 'node:assert/strict';
import { normalizeCredential } from '../src/channels/trae/auth.ts';

const TOKEN_EXP = Date.parse('2026-11-19T05:06:16Z');
const REFRESH_EXP = Date.parse('2027-05-04T05:06:16Z');

const cases = [
  {
    name: '桌面客户端 storage.json 的形状',
    input: {
      token: 'tok',
      refreshToken: 'ref',
      userId: '1234567890123456',
      account: { username: '用户60869301709' },
      expiredAt: '2026-11-19T05:06:16.732Z',
      refreshExpiredAt: '2027-05-04T05:06:16.732Z',
      host: 'https://api.trae.cn/',
      machineId: 'a76c383d',
      checkinDeviceId: '1111111111111111',
    },
    expect: {
      username: '用户60869301709',
      refreshBase: 'https://api.trae.cn',
      expiresAt: TOKEN_EXP + 732,
      refreshExpiresAt: REFRESH_EXP + 732,
      checkinDeviceId: '1111111111111111',
      source: 'login',
    },
  },
  {
    name: '网关自己写的缓存（expiresAt/username/refreshBase）+ source=login',
    input: {
      token: 'tok',
      refreshToken: 'ref',
      userId: '1234567890123456',
      username: '用户60869301709',
      refreshBase: 'https://api.trae.cn',
      expiresAt: TOKEN_EXP,
      refreshExpiresAt: REFRESH_EXP,
      machineId: 'a76c383d',
      checkinDeviceId: '1111111111111111',
      source: 'login',
    },
    expect: {
      username: '用户60869301709',
      refreshBase: 'https://api.trae.cn',
      expiresAt: TOKEN_EXP,
      refreshExpiresAt: REFRESH_EXP,
      checkinDeviceId: '1111111111111111',
      source: 'login',
    },
  },
  {
    name: '老缓存没有 source，按 login 处理',
    input: { token: 'tok', refreshToken: 'ref', userId: 'u', expiresAt: TOKEN_EXP },
    expect: { source: 'login', expiresAt: TOKEN_EXP, username: '', refreshBase: 'https://api.trae.cn' },
  },
  {
    name: '两个来源的字段都没有时不能抛，只留默认值',
    input: { token: 'tok' },
    expect: { expiresAt: 0, refreshExpiresAt: 0, username: '', refreshBase: 'https://api.trae.cn', source: 'login' },
  },
];

let failed = 0;
for (const item of cases) {
  const got = normalizeCredential(item.input);
  try {
    for (const [key, want] of Object.entries(item.expect)) {
      assert.deepEqual(got[key], want, `${key} 不匹配`);
    }
    if (item.input.expiresAt !== undefined && got.expiresAt === 0) {
      throw new Error('expiresAt 读成了 0——又会把登录换来的令牌判给客户端');
    }
    console.log(`  ok   ${item.name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${item.name}`);
    console.log(`       ${error.message}`);
    console.log(`       实际 ${JSON.stringify(got)}`);
  }
}

console.log(failed === 0 ? `\n全部通过（${cases.length} 项）` : `\n${failed}/${cases.length} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
