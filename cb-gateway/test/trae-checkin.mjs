// Trae 签到领取的回归测试：三种服务端状态，本地记录必须分清。
//
// 钉住的是 2026-11-11/12 那次踩坑：`claim` 抛 `9074 当前参与用户过多` 时，服务端
// 可能其实已经发了分（或者用户自己的客户端刚好领了），本地却记成一条 `error`，
// 面板上于是永远显示「签到失败」。所以失败后必须再读一次 status 才能下结论。
//
// 跑：node test/trae-checkin.mjs
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
  credential: null,
};

/** 每个用例都从这份凭据出发——换设备号的用例会改掉 `selfDeviceId`，不重置会串味。 */
const BASE_CREDENTIAL = {
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
};

function statusDoc(checkedIn, credits = 100) {
  return { code: 0, message: 'success', enable: true, checked_in: checkedIn, did_checked_in: false, credits, extra_credits: 0 };
}

const STATUS_PATH = '/trae/api/v2/ug/checkin_credits/status';
const CLAIM_PATH = '/trae/api/v2/ug/checkin_credits/claim';

// 假上游：`plan` 是「按调用顺序取」的响应表，key 是路径，值是该路径的响应队列。
let calls = [];
let plan = {};
/** 每次请求带的 `x-device-id`，按调用顺序记下来——换号重试要靠它断言。 */
let deviceIds = [];

function fakeResponse(json, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(json),
  };
}

globalThis.fetch = async (url, init = {}) => {
  const pathname = new URL(url).pathname;
  calls.push(pathname);
  deviceIds.push(init.headers?.['x-device-id'] ?? '(无)');
  const queue = plan[pathname];
  if (!queue || queue.length === 0) throw new Error(`测试没给 ${pathname} 排响应`);
  return fakeResponse(queue.shift());
};

/**
 * 把一份响应重复 N 次，铺满队列。
 *
 * 9074 会触发「换号重来」，一轮 = status + claim + status 三次请求，最多 3 轮（首发 + 2 次换号），
 * 所以「一路失败」要用 9 个响应。
 */
function repeat(doc, n) {
  return Array.from({ length: n }, () => ({ ...doc }));
}

function reset(accountOverride = {}) {
  calls = [];
  deviceIds = [];
  plan = {};
  account.credential = { ...BASE_CREDENTIAL, ...accountOverride };
}

// ---- 1. status 已签到：不该再打 claim ----
console.log('--- 1. 服务端说今天已签到 ---');
reset();
plan = { [STATUS_PATH]: [statusDoc(true, 100)] };
let record = await usage.claimCheckin(account);
check('记 already', record.status, 'already');
check('带上服务端的积分', record.credits, 100);
check('没打 claim', calls.includes(CLAIM_PATH), false);

// ---- 2. claim 报 9074 且换号后仍然失败：记 error，标成可重试，并保留业务码 ----
//
// 2026-11-14 起，9074 会**当场换设备号再试**（最多 2 轮）。所以「一路 9074」的用例
// 要铺满 3 轮的量：每轮 status + claim + status = 3 次，共 9 个响应。
console.log('\n--- 2. 9074 换号后仍失败 ---');
reset();
plan = {
  [STATUS_PATH]: repeat(statusDoc(false), 6),
  [CLAIM_PATH]: repeat({ code: 9074, message: '当前参与用户太多，请稍后再试' }, 3),
};
record = await usage.claimCheckin(account);
check('记 error', record.status, 'error');
check('message 带业务码和原文', /9074/.test(record.message) && /当前参与用户太多/.test(record.message), true);
check('标成可重试（调度器据此走密集阶梯）', record.transient, true);
check('带回业务码，供调度器/日志判断', record.upstreamCode, 9074);
check('首轮 + 2 次换号 = 打了 3 次 claim', calls.filter((p) => p === CLAIM_PATH).length, 3);
check('设备号换了 2 次（3 个不同的号）', new Set(deviceIds).size, 3);
check('换号写进了凭据（持久化）', account.credential.selfDeviceId !== BASE_CREDENTIAL.selfDeviceId, true);

// ---- 3. claim 报 9074，换号后成功 ----
//
// 这正是 2026-11-14 tr-3 的真实情形：旧号连续 9074，换号后第一次就过。
console.log('\n--- 3. 9074 换号后成功 ---');
reset();
plan = {
  [STATUS_PATH]: [statusDoc(false), statusDoc(false), statusDoc(false), statusDoc(true, 100)],
  [CLAIM_PATH]: [{ code: 9074, message: '当前参与用户太多，请稍后再试' }, { code: 0, message: 'success' }],
};
record = await usage.claimCheckin(account);
check('最终记 checked', record.status, 'checked');
check('积分来自领取后的状态', record.credits, 100);
check('只打了 2 次 claim（第 2 次就成）', calls.filter((p) => p === CLAIM_PATH).length, 2);
check('两次 claim 用的设备号不同', deviceIds.filter((d) => d).length >= 2 && new Set(deviceIds).size >= 2, true);

// ---- 4. 有 aha 真号时不换号——换了也不生效，别给假象 ----
console.log('\n--- 4. aha 真号存在时不换号 ---');
reset({ checkinDeviceId: '1111111111111111' });
plan = {
  [STATUS_PATH]: repeat(statusDoc(false), 6),
  [CLAIM_PATH]: repeat({ code: 9074, message: '当前参与用户太多，请稍后再试' }, 3),
};
record = await usage.claimCheckin(account);
check('记 error', record.status, 'error');
check('只打了 1 次 claim（没换号重来）', calls.filter((p) => p === CLAIM_PATH).length, 1);
check('aha 真号原样保留', account.credential.checkinDeviceId, '1111111111111111');
check('每次请求都带 aha 真号', [...new Set(deviceIds)], ['1111111111111111']);

// ---- 5. claim 报 9074，但服务端已经签上了：记 already，别留假失败 ----
console.log('\n--- 5. 9074 但服务端已签到 ---');
reset();
plan = {
  [STATUS_PATH]: [statusDoc(false), statusDoc(true, 100)],
  [CLAIM_PATH]: [{ code: 9074, message: '当前参与用户太多，请稍后再试' }],
};
record = await usage.claimCheckin(account);
check('记 already 而不是 error', record.status, 'already');
check('积分来自重读的状态', record.credits, 100);
check('换号也没被白换（只 1 次 claim）', calls.filter((p) => p === CLAIM_PATH).length, 1);

// ---- 6. claim 成功 ----
console.log('\n--- 6. claim 正常返回 success ---');
reset();
plan = {
  [STATUS_PATH]: [statusDoc(false), statusDoc(true, 120)],
  [CLAIM_PATH]: [{ code: 0, message: 'success' }],
};
record = await usage.claimCheckin(account);
check('记 checked', record.status, 'checked');
check('积分取领取后的状态', record.credits, 120);
check('打了 claim', calls.includes(CLAIM_PATH), true);
check('没换号', account.credential.selfDeviceId, BASE_CREDENTIAL.selfDeviceId);

// ---- 7. 非 9074 的失败不换号（换号解决不了凭据/参数问题）----
console.log('\n--- 7. 9004 之类不换号 ---');
reset();
plan = {
  [STATUS_PATH]: repeat(statusDoc(false), 4),
  [CLAIM_PATH]: [{ code: 9004, message: 'The submitted order parameters are incorrect' }],
};
record = await usage.claimCheckin(account);
check('记 error', record.status, 'error');
check('不标可重试（不是瞬时错误）', record.transient, false);
check('只打了 1 次 claim', calls.filter((p) => p === CLAIM_PATH).length, 1);
check('设备号没变', account.credential.selfDeviceId, BASE_CREDENTIAL.selfDeviceId);

// 先关库再删临时目录：Windows 上删不掉一个被打开的文件（EPERM）。
const { closeDb } = await import('../src/shared/db.ts');
closeDb();
fs.rmSync(tempData, { recursive: true, force: true });
console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
