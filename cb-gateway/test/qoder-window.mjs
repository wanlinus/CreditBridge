// 给 Qoder 的窗口判断补测试：10:00 之前是 pending，之后才可能 already/checked。
//
// 这段逻辑没法用真实时钟测（一天只有 10:00 前一小时走那个分支），所以直接对
// `beforeWindowOpen()` 做判断——把「当前时间」参数化。为此需要把那个函数导出。
//
// 跑：node test/qoder-window.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-qoder-window-'));
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

const usage = await import('../src/channels/qoder/usage.ts');

// 窗口判定必须导出才能测；没导出就明确报错，而不是静默跳过。
if (typeof usage.isBeforeCheckinWindow !== 'function') {
  console.log('  ✗ 找不到 isBeforeCheckinWindow 导出——窗口判定必须可测，否则这个分支永远没人验证');
  process.exitCode = 1;
  process.exit(1);
}

/** 构造北京时间某点的时间戳。 */
const bj = (iso) => new Date(iso).getTime();

console.log('--- Qoder 活动窗口判定（每天 10:00 北京时间开窗口，到次日 09:59）---');
check('09:00 今天还没到点', usage.isBeforeCheckinWindow(bj('2026-11-13T09:00:00+08:00')), true);
check('09:59 今天还没到点', usage.isBeforeCheckinWindow(bj('2026-11-13T09:59:00+08:00')), true);
check('10:00 今天窗口已开（左闭）', usage.isBeforeCheckinWindow(bj('2026-11-13T10:00:00+08:00')), false);
check('10:05（默认签到时间）已开', usage.isBeforeCheckinWindow(bj('2026-11-13T10:05:00+08:00')), false);
check('15:00 已开', usage.isBeforeCheckinWindow(bj('2026-11-13T15:00:00+08:00')), false);
check('23:59 已开', usage.isBeforeCheckinWindow(bj('2026-11-13T23:59:00+08:00')), false);
// 凌晨 00:30：属于「昨天 10:00 那一轮的尾巴」，但**今天这一轮确实还没开始**，
// 所以判断为 true（今天的 10:00 还没到）。这正是 `campaigns` 为空时想要的结论：
// 昨天那轮已领完 + 今天还没开 = 现在什么也领不到，但 10 点后还能领。
check('次日 00:30 今天还没到点（昨天那轮已结束）', usage.isBeforeCheckinWindow(bj('2026-11-14T00:30:00+08:00')), true);
check('次日 09:00 今天还没到点', usage.isBeforeCheckinWindow(bj('2026-11-14T09:00:00+08:00')), true);
check('次日 10:00 新窗口已开', usage.isBeforeCheckinWindow(bj('2026-11-14T10:00:00+08:00')), false);

// 先关库再删临时目录：Windows 上删不掉一个被打开的文件（EPERM）。
const { closeDb } = await import('../src/shared/db.ts');
closeDb();
fs.rmSync(tempData, { recursive: true, force: true });
console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
