// 签到调度器回归测试。
//
// 覆盖三件事：
//   1. 签到时间在设置里的配置与校验（`updateConfig` / `isValidCheckinTime`）；
//   2. 「到下一个签到点还有多久」的时序边界（`msUntilNextCheckin`）；
//   3. 「签一遍 → 失败的重试一次 → 再失败放弃」的完整流程（用假通道 + 假定时器驱动，
//      不真打网络）。
//
// 跑：node test/checkin-scheduler.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-checkin-'));
process.env.QB_DATA_DIR = tempData;

const configMod = await import('../src/config.ts');
const scheduler = await import('../src/core/checkin-scheduler.ts');
const accounts = await import('../src/core/accounts.ts');
const { channels } = await import('../src/channels/index.ts');

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

// ---- 1. 签到时间配置与校验 ----
console.log('--- 1. 签到时间配置与校验 ---');
// 默认 10:05 而不是 09:00：Qoder 的签到活动每天 10:00 才开窗口（见 qoder/usage.ts）。
// 定在 09:00 会让它每天在窗口开启前一小时去领，永远拿到空列表（2026-11-13 定位）。
check('默认签到时间 10:05', configMod.config.checkinTime, '10:05');
check('合法时间通过', configMod.isValidCheckinTime('09:30'), true);
check('合法时间 23:59 通过', configMod.isValidCheckinTime('23:59'), true);
check('合法时间 00:00 通过', configMod.isValidCheckinTime('00:00'), true);
check('非法：24:00', configMod.isValidCheckinTime('24:00'), false);
check('非法：9:00（缺前导零）', configMod.isValidCheckinTime('9:00'), false);
check('非法：09:60', configMod.isValidCheckinTime('09:60'), false);
check('非法：空串', configMod.isValidCheckinTime(''), false);
check('非法：非字符串', configMod.isValidCheckinTime(930), false);

check('改签到时间', configMod.updateConfig({ checkinTime: '07:15' }).ok, true);
check('改完内存立即生效', configMod.config.checkinTime, '07:15');
const onDisk = JSON.parse(fs.readFileSync(path.join(tempData, 'config.json'), 'utf8'));
check('改完落盘', onDisk.checkinTime, '07:15');

check('非法时间被拒', configMod.updateConfig({ checkinTime: '25:00' }).ok, false);
check('拒后原值不变', configMod.config.checkinTime, '07:15');
check('白名单外的键被拒', configMod.updateConfig({ port: 9999 }).ok, false);
configMod.updateConfig({ checkinTime: '09:00' });

// ---- 2. 到点时序 ----
console.log('\n--- 2. 到点时序（msUntilNextCheckin）---');
const at = (h, m) => new Date(2026, 0, 15, h, m, 0, 0); // 2026-01-15 本地时间
check('09:00 点时，离当天 09:00 还有 0', scheduler.msUntilNextCheckin(at(9, 0)), 0);
check('08:59 时，还有 1 分钟', scheduler.msUntilNextCheckin(at(8, 59)), 60000);
check('09:01 时，等明天的点（23 小时 59 分）', scheduler.msUntilNextCheckin(at(9, 1)), 23 * 3600000 + 59 * 60000);
check('跨天：23:00 时，离次日 09:00 有 10 小时', scheduler.msUntilNextCheckin(at(23, 0)), 10 * 3600000);

// 改了签到时间，时序跟着变
configMod.updateConfig({ checkinTime: '20:00' });
check('改到 20:00 后，08:00 时还有 12 小时', scheduler.msUntilNextCheckin(at(8, 0)), 12 * 3600000);
configMod.updateConfig({ checkinTime: '09:00' });

// ---- 3. 签一遍 + 失败重试一次 ----
console.log('\n--- 3. 签一遍 + 失败重试一次 ---');
// 清掉真实通道，换成两个假通道：一个成功、一个总是失败，还有一个不支持签到。
channels.splice(0, channels.length);
accounts.loadAccounts();

const calls = []; // 记录每次 claim 的账号，断言重试只对失败的号再来一次
const alwaysFail = {
  id: 'fail',
  idPrefix: 'fa',
  label: 'Fail',
  checkinClaimOf: async (account) => {
    calls.push(account.id);
    throw new Error('上游抖动');
  },
  lastCheckinOf: () => null,
};
const alwaysOk = {
  id: 'ok',
  idPrefix: 'ok',
  label: 'Ok',
  checkinClaimOf: async (account) => {
    calls.push(account.id);
    return { date: new Date().toISOString().slice(0, 10), status: 'checked', credits: 5 };
  },
  lastCheckinOf: () => null,
};
const noCheckin = { id: 'none', idPrefix: 'no', label: 'None' };
/**
 * 「窗口还没开」的通道：返回 `pending`。
 *
 * 这是 Qoder 的真实形态——活动每天 10:00 才开窗口，09:00 去领会拿到空列表。
 * **`pending` 不能被当成「今天结束了」**，否则那天就再也不会重试，等于永远领不到。
 */
const stillPending = {
  id: 'pending',
  idPrefix: 'pd',
  label: 'Pending',
  checkinClaimOf: async (account) => {
    calls.push(account.id);
    return { date: new Date().toISOString().slice(0, 10), status: 'pending', message: '今天这一轮还没开始' };
  },
  lastCheckinOf: () => null,
};
channels.push(alwaysFail, alwaysOk, noCheckin, stillPending);

const fa1 = accounts.addAccount({ channelId: 'fail', idPrefix: 'fa', credential: {} });
const ok1 = accounts.addAccount({ channelId: 'ok', idPrefix: 'ok', credential: {} });
const pd1 = accounts.addAccount({ channelId: 'pending', idPrefix: 'pd', credential: {} });

// 注入假定时器：立即触发，好断言重试发生
let scheduledFns = [];
scheduler.setSchedulerHooksForTests({
  retryDelayMs: 1,
  setTimeout: (fn) => {
    scheduledFns.push(fn);
    return 0;
  },
});

const failedIds = await scheduler.runOnce();
check('失败的账号被记下', failedIds, [{ id: fa1.id }, { id: pd1.id }]);
check('成功的账号只签一次（不重试）', calls.filter((id) => id === ok1.id).length, 1);
check('失败的账号第一次签了', calls.filter((id) => id === fa1.id).length, 1);
check('不支持签到的通道被跳过', calls.includes('none-1'), false);
// `pending` 必须进重试：窗口还没开≠今天结束（2026-11-13 之前它被记成 already，永远不重试）
check('pending（窗口未开）也进重试阶梯', calls.filter((id) => id === pd1.id).length, 1);
check('排了一次重试', scheduledFns.length, 1);

// 执行重试：失败的那个号再签一次（又失败）
await scheduledFns[0]();
check('重试后失败的号被再签一次', calls.filter((id) => id === fa1.id).length, 2);
check('成功的号没被重试牵连', calls.filter((id) => id === ok1.id).length, 1);

// 重试里没有再排第三次（runOnce 只排一次重试，重试内部不再递归）
check('不递归重试：排队的定时器还是 1 个', scheduledFns.length, 1);

// 失败一次后「今天已有结论」判定：失败的号不该被 settled 拦住（它没写成功记录），
// 但重试也失败后，调度不再追加——这就是「再失败就放弃」的边界，由 runOnce 不递归保证。

// ---- 3b. transient 错误走 10/30/60 分钟的阶梯，其他错误不走 ----
console.log('\n--- 3b. transient 错误的重试阶梯 ---');
// 这一节要单独跑一轮：把上两节的假通道先摘掉，免得它们的失败把日志条数搅乱。
const previousChannels = channels.splice(0, channels.length);
const busyCalls = [];
const busyFail = {
  id: 'busy',
  idPrefix: 'bz',
  label: 'Busy',
  checkinClaimOf: async (account) => {
    busyCalls.push(account.id);
    const error = new Error('Trae account API code 9074: 当前参与用户太多，请稍后再试');
    error.transient = true;
    throw error;
  },
  lastCheckinOf: () => null,
};
channels.push(busyFail);
const bz1 = accounts.addAccount({ channelId: 'busy', idPrefix: 'bz', credential: {} });

scheduledFns = [];
const busyFailed = await scheduler.runOnce();
check('transient 失败被记下', busyFailed.map((item) => item.id), [bz1.id]);
check('首轮只排一个定时器', scheduledFns.length, 1);

await scheduledFns[0]();
check('阶梯第 1 次重试后排出第 2 个', scheduledFns.length, 2);
await scheduledFns[1]();
check('阶梯第 2 次重试后排出第 3 个', scheduledFns.length, 3);
await scheduledFns[2]();
check('阶梯走完不再排（3 次封顶）', scheduledFns.length, 3);
check('transient 号一共打了 4 次（首轮 + 3 次重试）', busyCalls.filter((id) => id === bz1.id).length, 4);

// 还原通道，后面的日志断言和一键签到还要用它们
channels.splice(0, channels.length, ...previousChannels);

// ---- 3c. 通道「返回 error 记录」（不抛异常）也要进重试阶梯 ----
console.log('\n--- 3c. 返回 error 记录（不抛）的重试 ---');
// 生产里的三个通道都是这个形态：把异常吞成一条 `status: 'error'` 记录再返回，
// 因为它们要先重查一次上游状态、确认不是「我们报错但服务端其实已经签到」。
// 2026-11-12 之前调度器只认 catch，于是真实失败从来没进过重试阶梯——这一节
// 就是钉住那条接缝，光靠 3b 那种「假通道抛异常」的写法永远测不出来。
const softCalls = [];
const softFail = {
  id: 'soft',
  idPrefix: 'sf',
  label: 'Soft',
  checkinClaimOf: async (account) => {
    softCalls.push(account.id);
    return {
      date: new Date().toISOString().slice(0, 10),
      status: 'error',
      message: 'Trae account API code 9074: 当前参与用户太多，请稍后再试',
      transient: true,
    };
  },
  lastCheckinOf: () => null,
};
const softPrevious = channels.splice(0, channels.length);
channels.push(softFail);
const sf1 = accounts.addAccount({ channelId: 'soft', idPrefix: 'sf', credential: {} });

scheduledFns = [];
const softFailed = await scheduler.runOnce();
check('返回 error 记录也算失败', softFailed.map((item) => item.id), [sf1.id]);
check('返回 error 记录的首轮排一个定时器', scheduledFns.length, 1);
await scheduledFns[0]();
await scheduledFns[1]();
await scheduledFns[2]();
check('返回 error 记录也走完 3 次阶梯（共 4 次）', softCalls.filter((id) => id === sf1.id).length, 4);

channels.splice(0, channels.length, ...softPrevious);

// ---- 3d. 今天已经全部有结论：一个号都不签，安静返回 ----
console.log('\n--- 3d. 今天没有待签账号 ---');
// 同时钉住两件事：已签/已领的号不会被重复打上游；`runOnce` 在无事可做时不抛异常、
// 返回空数组（2026-11-12 在这条分支加了留痕日志，之前它是彻底静默的）。
// 用**本地日期**而不是 `toISOString()`：`localDate()` 按本地日历日算，测试要是在
// UTC 16:00 之后跑（= 北京时间第二天凌晨），UTC 日期会比本地日期早一天，判据就反了。
const localToday = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const settledCalls = [];
const settledChannel = {
  id: 'settled',
  idPrefix: 'st',
  label: 'Settled',
  checkinClaimOf: async (account) => {
    settledCalls.push(account.id);
    return { date: localToday(), status: 'checked' };
  },
  lastCheckinOf: () => ({ date: localToday(), status: 'checked' }),
};
const settledPrevious = channels.splice(0, channels.length);
channels.push(settledChannel);
accounts.addAccount({ channelId: 'settled', idPrefix: 'st', credential: {} });

scheduledFns = [];
const settledResult = await scheduler.runOnce();
check('今天已有结论的号不被重复签', settledResult, []);
check('一个上游请求都没打', settledCalls.length, 0);
check('也没有排重试', scheduledFns.length, 0);

channels.splice(0, channels.length, ...settledPrevious);

// ---- 4. 签到日志被写进去 ----
console.log('\n--- 4. 签到日志（source=auto）---');
const checkinLog = await import('../src/core/checkin-log.ts');
const log = checkinLog.readCheckinLog();
check('调度签到的日志有记录', log.length >= 2, true);
// 最新的在前：重试那次失败在最后，ok 的成功在其前
check('日志按时间倒序', log[0].ts >= log[1].ts, true);
const okEntry = log.find((e) => e.account === ok1.id);
const failEntry = log.find((e) => e.account === fa1.id);
check('成功的账号日志 status=checked', okEntry?.status, 'checked');
check('成功的账号日志带积分', okEntry?.credits, 5);
check('成功的账号日志 source=auto', okEntry?.source, 'auto');
check('失败的账号日志 status=error', failEntry?.status, 'error');
check('失败的账号日志带原因', failEntry?.message, '上游抖动');
check('失败的账号日志 source=auto', failEntry?.source, 'auto');
// 失败账号被签了两次（首次 + 重试），日志也应是两条
check('失败的账号日志有两条（首次 + 重试）', log.filter((e) => e.account === fa1.id).length, 2);

// ---- 5. 一键签到（checkinAllAccounts）----
console.log('\n--- 5. 一键签到（source=manual）---');
const beforeAll = checkinLog.readCheckinLog().length;
const allResults = await scheduler.checkinAllAccounts();
// ok 成功、fail 报错、pending 未到时间，noCheckin 通道没有 checkinClaimOf 被跳过
check('一键签到返回 ok 账号结果', allResults.find((r) => r.account === ok1.id)?.status, 'checked');
check('一键签到返回 fail 账号结果', allResults.find((r) => r.account === fa1.id)?.status, 'error');
check('一键签到把 pending 如实报出来', allResults.find((r) => r.account === pd1.id)?.status, 'pending');
check('一键签到不签不支持签到的通道', allResults.some((r) => r.channel === 'none'), false);
check('一键签到结果条数 = 3（ok + fail + pending）', allResults.length, 3);

const afterAll = checkinLog.readCheckinLog();
check('一键签到写日志（新增 3 条）', afterAll.length, beforeAll + 3);
const manualOk = afterAll.find((e) => e.account === ok1.id && e.source === 'manual');
const manualFail = afterAll.find((e) => e.account === fa1.id && e.source === 'manual');
check('一键签到的成功日志 source=manual', manualOk?.status, 'checked');
check('一键签到的失败日志 source=manual', manualFail?.status, 'error');
check('一键签到不重试（fail 账号只多一条 manual，没有自动重试）', afterAll.filter((e) => e.account === fa1.id && e.source === 'manual').length, 1);

scheduler.resetSchedulerHooksForTests();
// 先关库再删临时目录：Windows 上删不掉一个被打开的文件（EPERM）。
const { closeDb } = await import('../src/shared/db.ts');
closeDb();
fs.rmSync(tempData, { recursive: true, force: true });
console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
