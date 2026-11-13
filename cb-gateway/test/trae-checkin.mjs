import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-trae-checkin-'));
process.env.QB_DATA_DIR = tempData;

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

const usage = await import('../src/channels/trae/usage.ts');

const account = {
  id: 'tr-9',
  channelId: 'trae',
  status: 'ready',
  credential: {
    token: 'fake.jwt.token',
    refreshToken: 'refresh',
    userId: 'u1',
    username: '用户1',
    refreshBase: 'https://api.trae.cn',
    expiresAt: Date.now() + 3600_000,
    refreshExpiresAt: Date.now() + 7200_000,
    machineId: '',
    checkinDeviceId: '',
    selfDeviceId: '7600000000000001',
    privateKeyPEM: '',
    publicKeyPEM: '',
    source: 'login',
  },
};

const STATUS_PATH = '/trae/api/v2/ug/checkin_credits/status';
const CLAIM_PATH = '/trae/api/v2/ug/checkin_credits/claim';

let calls = [];
let plan = {};

function fakeResponse(json, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(json),
  };
}

globalThis.fetch = async (url) => {
  const pathname = new URL(url).pathname;
  calls.push(pathname);
  const queue = plan[pathname];
  if (!queue || queue.length === 0) throw new Error(`测试没给 ${pathname} 排响应`);
  return fakeResponse(queue.shift());
};

function statusDoc(checkedIn, credits = 100) {
  return { code: 0, message: 'success', enable: true, checked_in: checkedIn, did_checked_in: false, credits, extra_credits: 0 };
}

console.log('--- 1. 服务端说今天已签到 ---');
calls = [];
plan = { [STATUS_PATH]: [statusDoc(true, 100)] };
let record = await usage.claimCheckin(account);
check('记 already', record.status, 'already');
check('带上服务端的积分', record.credits, 100);
check('没打 claim', calls.includes(CLAIM_PATH), false);

console.log('\n--- 2. claim 报 9074 且确实没签到 ---');
calls = [];
plan = {
  [STATUS_PATH]: [statusDoc(false), statusDoc(false)],
  [CLAIM_PATH]: [{ code: 9074, message: '当前参与用户太多，请稍后再试' }],
};
record = await usage.claimCheckin(account);
check('记 error', record.status, 'error');
check('message 带业务码和原文', /9074/.test(record.message) && /当前参与用户太多/.test(record.message), true);
check('失败后重读了 status（status 被调 2 次）', calls.filter((p) => p === STATUS_PATH).length, 2);

console.log('\n--- 3. claim 报 9074 但服务端已签到 ---');
calls = [];
plan = {
  [STATUS_PATH]: [statusDoc(false), statusDoc(true, 100)],
  [CLAIM_PATH]: [{ code: 9074, message: '当前参与用户太多，请稍后再试' }],
};
record = await usage.claimCheckin(account);
check('记 already 而不是 error', record.status, 'already');
check('积分来自重读的状态', record.credits, 100);

console.log('\n--- 4. claim 正常返回 success ---');
calls = [];
plan = {
  [STATUS_PATH]: [statusDoc(false), statusDoc(true, 120)],
  [CLAIM_PATH]: [{ code: 0, message: 'success' }],
};
record = await usage.claimCheckin(account);
check('记 checked', record.status, 'checked');
check('积分取领取后的状态', record.credits, 120);
check('打了 claim', calls.includes(CLAIM_PATH), true);

fs.rmSync(tempData, { recursive: true, force: true });
console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
