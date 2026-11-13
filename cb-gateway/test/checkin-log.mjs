import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-checkin-log-'));
process.env.QB_DATA_DIR = tempData;

const { appendCheckinLog, readCheckinLog, resetCheckinLogForTests } = await import('../src/core/checkin-log.ts');

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

resetCheckinLogForTests();
check('空日志返回空数组', readCheckinLog(), []);

appendCheckinLog({ ts: 1000, account: 'wb-1', channel: 'workbuddy', status: 'checked', credits: 5, source: 'auto' });
appendCheckinLog({ ts: 2000, account: 'tr-1', channel: 'trae', status: 'error', message: '上游抖动', source: 'auto' });
appendCheckinLog({ ts: 3000, account: 'wb-1', channel: 'workbuddy', status: 'already', source: 'manual' });

const log = readCheckinLog();
check('三条都读出来', log.length, 3);
check('按时间倒序（最新在前）', log.map((e) => e.ts), [3000, 2000, 1000]);
check('状态和积分都保留', log[2], { ts: 1000, account: 'wb-1', channel: 'workbuddy', status: 'checked', credits: 5, source: 'auto' });
check('message 保留', log[1].message, '上游抖动');
check('source 区分手动/自动', [log[0].source, log[2].source], ['manual', 'auto']);

appendCheckinLog({ ts: 4000, account: 'wb-1', channel: 'workbuddy', status: 'checked', credits: 6, source: 'auto' });
check('追加后是 4 条（不覆盖旧的）', readCheckinLog().length, 4);

const file = path.join(tempData, 'state', 'checkin-log.jsonl');
check('日志文件写出来了', fs.existsSync(file), true);
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
check('文件里是 4 行（jsonl 追加式）', lines.length, 4);

fs.appendFileSync(file, '这不是 JSON\n', 'utf8');
check('坏行被跳过，好的还在', readCheckinLog().length, 4);

fs.rmSync(tempData, { recursive: true, force: true });
console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
