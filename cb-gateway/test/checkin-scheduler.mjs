// 守护重试阶梯：通道返回 status:'error' 记录（不抛异常）也必须进重试，且 transient 走 10/30/60 分钟阶梯。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, section, done } from './_helpers.mjs';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-checkin-'));
process.env.QB_DATA_DIR = tempData;

const configMod = await import('../src/config.ts');
const scheduler = await import('../src/core/checkin-scheduler.ts');
const accounts = await import('../src/core/accounts.ts');
const { channels } = await import('../src/channels/index.ts');

section('1. 签到时间配置与校验');
// 默认 10:05 而不是 09:00：Qoder 的签到活动每天 10:00 才开窗口，定在 09:00 会每天在开窗前空领。
check('默认签到时间 10:05', configMod.config.checkinTime, '10:05');
for (const [name, input, expected] of [
  ['合法 09:30', '09:30', true],
  ['合法 23:59', '23:59', true],
  ['合法 00:00', '00:00', true],
  ['非法 24:00', '24:00', false],
  ['非法 9:00（缺前导零）', '9:00', false],
  ['非法 09:60', '09:60', false],
  ['非法 空串', '', false],
  ['非法 非字符串', 930, false],
]) check(`签到时间 ${name}`, configMod.isValidCheckinTime(input), expected);

check('改签到时间', configMod.updateConfig({ checkinTime: '07:15' }).ok, true);
check('改完内存立即生效', configMod.config.checkinTime, '07:15');
const onDisk = JSON.parse(fs.readFileSync(path.join(tempData, 'config.json'), 'utf8'));
check('改完落盘', onDisk.checkinTime, '07:15');

check('非法时间被拒', configMod.updateConfig({ checkinTime: '25:00' }).ok, false);
check('拒后原值不变', configMod.config.checkinTime, '07:15');
check('白名单外的键被拒', configMod.updateConfig({ port: 9999 }).ok, false);
configMod.updateConfig({ checkinTime: '09:00' });

section('2. 到点时序（msUntilNextCheckin）');
const at = (h, m) => new Date(2026, 0, 15, h, m, 0, 0); // 2026-01-15 本地时间
for (const [name, h, m, expected] of [
  ['正点还有 0', 9, 0, 0],
  ['08:59 还有 1 分钟', 8, 59, 60000],
  ['09:01 等明天的点', 9, 1, 23 * 3600000 + 59 * 60000],
  ['跨天 23:00 还有 10 小时', 23, 0, 10 * 3600000],
]) check(`09:00 目标，${name}`, scheduler.msUntilNextCheckin(at(h, m)), expected);

configMod.updateConfig({ checkinTime: '20:00' });
check('改到 20:00 后，08:00 时还有 12 小时', scheduler.msUntilNextCheckin(at(8, 0)), 12 * 3600000);
configMod.updateConfig({ checkinTime: '09:00' });

section('3. 签一遍 + 失败重试一次');
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
// 窗口还没开的通道（Qoder 真实形态）：返回 pending。pending ≠ 今天结束，否则永远不再重试。
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
check('pending（窗口未开）也进重试阶梯', calls.filter((id) => id === pd1.id).length, 1);
check('排了一次重试', scheduledFns.length, 1);

await scheduledFns[0]();
check('重试后失败的号被再签一次', calls.filter((id) => id === fa1.id).length, 2);
check('成功的号没被重试牵连', calls.filter((id) => id === ok1.id).length, 1);
check('不递归重试：排队的定时器还是 1 个', scheduledFns.length, 1);

section('3b. transient 错误的重试阶梯');
// 单独跑一轮：先摘掉上面的假通道，免得它们的失败搅乱日志条数。
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

channels.splice(0, channels.length, ...previousChannels);

section('3c. 返回 error 记录（不抛）的重试');
// 生产通道把异常吞成 status:'error' 记录返回（要先重查上游是否其实已签到）。
// 调度器只认 catch 会漏掉整条路径——这一节钉住那条接缝，3b 的「假通道抛异常」测不出来。
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

section('3d. 今天没有待签账号');
// 已签/已领的号不重复打上游；runOnce 无事可做时不抛异常、返回空数组。
// 用本地日期：测试若在 UTC 16:00 后跑（= 北京时间第二天），UTC 日期会比本地早一天。
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

section('4. 签到日志（source=auto）');
const checkinLog = await import('../src/core/checkin-log.ts');
const log = checkinLog.readCheckinLog();
check('调度签到的日志有记录', log.length >= 2, true);
check('日志按时间倒序', log[0].ts >= log[1].ts, true);
const okEntry = log.find((e) => e.account === ok1.id);
const failEntry = log.find((e) => e.account === fa1.id);
check('成功的账号日志 status=checked', okEntry?.status, 'checked');
check('成功的账号日志带积分', okEntry?.credits, 5);
check('成功的账号日志 source=auto', okEntry?.source, 'auto');
check('失败的账号日志 status=error', failEntry?.status, 'error');
check('失败的账号日志带原因', failEntry?.message, '上游抖动');
check('失败的账号日志 source=auto', failEntry?.source, 'auto');
check('失败的账号日志有两条（首次 + 重试）', log.filter((e) => e.account === fa1.id).length, 2);

section('5. 一键签到（source=manual）');
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
done();
