// 签到日志（`checkin_log` 表，v4 起进库）回归测试。
//
// 只测两件事：追加是只增不减的、读出来按时间倒序。历史不能被下一次签到覆盖，这是
// 它和「当天幂等状态」的根本区别。
//
// 跑：node test/checkin-log.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-checkin-log-'));
process.env.QB_DATA_DIR = tempData;

const { appendCheckinLog, readCheckinLog, resetCheckinLogForTests } = await import('../src/core/checkin-log.ts');
const { db } = await import('../src/shared/db.ts');

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
check('状态和积分都保留', [log[2].account, log[2].status, log[2].credits], ['wb-1', 'checked', 5]);
check('message 保留', log[1].message, '上游抖动');
check('source 区分手动/自动', [log[0].source, log[2].source], ['manual', 'auto']);

// 追加再读：历史不覆盖，只往后长
appendCheckinLog({ ts: 4000, account: 'wb-1', channel: 'workbuddy', status: 'checked', credits: 6, source: 'auto' });
check('追加后是 4 条（不覆盖旧的）', readCheckinLog().length, 4);

// 真进库了，而且是 4 行
const rows = db.prepare('SELECT COUNT(*) AS n FROM checkin_log').get();
check('库里是 4 行', rows.n, 4);

// ---- 「坏行跳过」「文件里几行」这两组已经删掉 ----
//
// 进库之前这里往 jsonl 里塞半截 JSON，验证「坏行跳过、好行还在」。SQLite 给不出
// 半行，而且 `streak_days` / `credits` 这些列是强类型的，坏值根本写不进去。
// 留着只会让人以为还有一条字节级的降级路径要维护。

// 先关库再删临时目录：Windows 上删不掉一个被打开的文件（EPERM）。
const { closeDb } = await import('../src/shared/db.ts');
closeDb();
fs.rmSync(tempData, { recursive: true, force: true });
console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
