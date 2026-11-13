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

if (typeof usage.isBeforeCheckinWindow !== 'function') {
  console.log('  ✗ 找不到 isBeforeCheckinWindow 导出——窗口判定必须可测，否则这个分支永远没人验证');
  process.exitCode = 1;
  fs.rmSync(tempData, { recursive: true, force: true });
  process.exit(1);
}

const bj = (iso) => new Date(iso).getTime();

console.log('--- Qoder 活动窗口判定（每天 10:00 北京时间开窗口，到次日 09:59）---');
check('09:00 今天还没到点', usage.isBeforeCheckinWindow(bj('2026-11-13T09:00:00+08:00')), true);
check('09:59 今天还没到点', usage.isBeforeCheckinWindow(bj('2026-11-13T09:59:00+08:00')), true);
check('10:00 今天窗口已开（左闭）', usage.isBeforeCheckinWindow(bj('2026-11-13T10:00:00+08:00')), false);
check('10:05（默认签到时间）已开', usage.isBeforeCheckinWindow(bj('2026-11-13T10:05:00+08:00')), false);
check('15:00 已开', usage.isBeforeCheckinWindow(bj('2026-11-13T15:00:00+08:00')), false);
check('23:59 已开', usage.isBeforeCheckinWindow(bj('2026-11-13T23:59:00+08:00')), false);
check('次日 00:30 今天还没到点（昨天那轮已结束）', usage.isBeforeCheckinWindow(bj('2026-11-14T00:30:00+08:00')), true);
check('次日 09:00 今天还没到点', usage.isBeforeCheckinWindow(bj('2026-11-14T09:00:00+08:00')), true);
check('次日 10:00 新窗口已开', usage.isBeforeCheckinWindow(bj('2026-11-14T10:00:00+08:00')), false);

fs.rmSync(tempData, { recursive: true, force: true });
console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
