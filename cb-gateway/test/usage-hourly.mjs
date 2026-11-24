// 单日 24 小时视图（`usageHourly`）的回归测试。
//
// 这一层错的方式都是「不报错、只是数字错」：小时错位一格、跨天漏一条、费用按整天的
// 峰谷算而不是按每条记录自己的时刻算。所以这里钉四件事：
//
//   1. `hours` **恒 24 项**（缺的小时补 0），前端不该自己补齐；
//   2. 记录落在**它自己那个小时**里（用「3 天前」避开今天还没过完的边界）；
//   3. 费用**逐条按各自 ts 判峰谷**——23 点永远是空闲价，9 点看是不是工作日；
//   4. 日期非法 / 未来直接抛错（路由会转 400）。
//
// 跑：node test/usage-hourly.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-gw-hourly-'));
process.env.QB_DATA_DIR = tempData;

const { insertUsage, usagePricingRows } = await import('../src/store/usage.ts');
const { usageHourly } = await import('../src/ledger.ts');
const { measuredCacheHitRate } = await import('../src/shared/deepseek-pricing.ts');

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

/** 本地日历日的 `YYYY-MM-DD`。 */
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// 用「3 天前」而不是今天：今天的未来小时是空的，边界断言会变得看运行时刻。
const target = new Date();
target.setDate(target.getDate() - 3);
target.setHours(0, 0, 0, 0);
const TARGET_KEY = dayKey(target);
const at = (hour, minute = 30) => target.getTime() + hour * 3600000 + minute * 60000;

/** 独立复述一遍峰谷规则：工作日 9-12、14-18。 */
const isPeakAt = (day, hour) => day.getDay() >= 1 && day.getDay() <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));

const rows = [
  // 目标日：0 点、9 点、12 点整后（边界外）、23 点
  { ts: at(0), provider: 'workbuddy', account: 'wb-1', model: 'm', credit: 1, promptTokens: 1000, completionTokens: 10, cachedTokens: 900, status: 200 },
  { ts: at(9), provider: 'workbuddy', account: 'wb-1', model: 'm', credit: 2, promptTokens: 2000, completionTokens: 20, cachedTokens: 0, status: 200 },
  { ts: at(12), provider: 'workbuddy', account: 'wb-2', model: 'm', credit: 3, promptTokens: 3000, completionTokens: 30, status: 499 },
  { ts: at(23), provider: 'qoder', account: 'qd-1', model: 'q', credit: 4, promptTokens: 4000, completionTokens: 40, status: 200 },
  // 前一天同一小时：不能算进来
  { ts: at(9) - 86400000, provider: 'workbuddy', account: 'wb-1', model: 'm', credit: 100, promptTokens: 99999, status: 200 },
];
for (const row of rows) insertUsage(row);

const day = usageHourly(TARGET_KEY);

console.log('--- 1. 形状 ---');
check('hours 恒 24 项', day.hours.length, 24);
check('hour 是 0..23 升序', day.hours.map((h) => h.hour), Array.from({ length: 24 }, (_, i) => i));
check('date 原样回显', day.date, TARGET_KEY);
check('weekday 与本地一致', day.weekday, target.getDay());
check('isPeakDay 跟着星期几', day.isPeakDay, target.getDay() >= 1 && target.getDay() <= 5);

console.log('\n--- 2. 记录落在自己的小时里 ---');
check('0 点那一格', [day.hours[0].requests, day.hours[0].tokens], [1, 1010]);
check('9 点那一格', [day.hours[9].requests, day.hours[9].tokens], [1, 2020]);
check('12 点那一格（边界外仍算这天）', day.hours[12].requests, 1);
check('23 点那一格', day.hours[23].requests, 1);
check('没记录的小时补 0（不是缺项）', [day.hours[1].requests, day.hours[1].tokens, day.hours[1].cost.cny], [0, 0, 0]);
check('前一天那条没混进来（总量 4 条）', day.totals.requests, 4);
check('前一天那条的 token 没混进来', day.totals.tokens, 1010 + 2020 + 3030 + 4040);
check('cachedTokens 单独汇总', day.totals.cachedTokens, 900);

console.log('\n--- 3. 费用按每条记录自己的时刻分峰谷 ---');
check('9 点的 peak 标记与本地规则一致', day.hours[9].peak, isPeakAt(target, 9));
check('23 点永远不是峰时', day.hours[23].peak, false);
check('23 点的费用全算在空闲档', [day.hours[23].cost.peakCny, day.hours[23].cost.offPeakCny > 0], [0, true]);
if (isPeakAt(target, 9)) {
  check('工作日 9 点的费用全算在高峰档', [day.hours[9].cost.peakCny > 0, day.hours[9].cost.offPeakCny], [true, 0]);
} else {
  check('非工作日 9 点不按高峰计价', [day.hours[9].cost.peakCny, day.hours[9].cost.offPeakCny > 0], [0, true]);
}
const hourCostSum = day.hours.reduce((s, h) => s + h.cost.cny, 0);
check('合计费用 = 24 个小时之和', Math.abs(day.totals.cost.cny - hourCostSum) < 1e-9, true);
check('合计的峰谷拆分各自求和', Math.abs(day.totals.cost.cny - (day.totals.cost.peakCny + day.totals.cost.offPeakCny)) < 1e-9, true);

console.log('\n--- 4. 按账号收窄 ---');
const only = usageHourly(TARGET_KEY, { account: 'wb-1' });
check('只算 wb-1 的两条', only.totals.requests, 2);
check('wb-1 的 token 只有它自己的', only.totals.tokens, 1010 + 2020);
check('没命中的小时仍是 0 而不是缺项', only.hours[23].requests, 0);

console.log('\n--- 5. 非法日期与未来 ---');
const throws = (fn) => {
  try {
    fn();
    return 'no-error';
  } catch (error) {
    return error.message;
  }
};
check('格式不对被拒', throws(() => usageHourly('2026/11/13')).includes('YYYY-MM-DD'));
check('不存在的日子被拒（不能被 JS 进位成 3 月 2 日）', throws(() => usageHourly('2026-02-30')).includes('不是合法日期'));
check('13 月被拒', throws(() => usageHourly('2026-13-01')).includes('不是合法日期'));
const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
check('未来的日子被拒', throws(() => usageHourly(dayKey(tomorrow))).includes('未来'));

console.log('\n--- 6. 空数据的某一天 ---');
const emptyDay = new Date(target.getTime() - 10 * 86400000);
const empty = usageHourly(dayKey(emptyDay));
check('没有记录的那天也回 24 项', empty.hours.length, 24);
check('那天全 0，不是报错', [empty.totals.requests, empty.totals.tokens, empty.totals.cost.cny], [0, 0, 0]);

console.log('\n--- 7. Trae 的缓存按「其他通道实测平均」推算 ---');
//
// Trae 从不报 cache_read_input_tokens（2026-11-13 抓它自己的客户端也是 0），所以按
// **本窗口内其他通道的实测加权率**推算。这里钉四件事：① 推算真的进了缓存列和费用；
// ② 推算量被单独报出来；③ 上游报了真值的记录不被推算；④ 平均率是按 token 加权的。
//
// 数据：WorkBuddy 100K 输入、90K 命中 → 实测率 90%；Trae 100K 输入不报 → 按 90% 推 90K。
insertUsage({ ts: at(15), provider: 'trae', account: 'tr-9', model: 't', credit: null, promptTokens: 100000, completionTokens: 0, status: 200 });
insertUsage({ ts: at(15), provider: 'workbuddy', account: 'wb-9', model: 'w', credit: null, promptTokens: 100000, cachedTokens: 90000, completionTokens: 0, status: 200 });

const withEstimate = usageHourly(TARGET_KEY);
// 实测率不能写死：这个 fixture 里还有其他 WB 行参与加权。**按同一份数据自己算一遍**，
// 断言的才是「推算 = prompt × 实测率」这条规则，而不是某个魔法数字。
const rate = measuredCacheHitRate(usagePricingRows({}, target.getTime(), target.getTime() + 86400000));
const expectedAssumed = Math.floor(100000 * rate);
check('实测率算得出来', typeof rate, 'number');
check('Trae 的输入按实测率推算', withEstimate.totals.cost.assumedCachedTokens, expectedAssumed);
// 15 点是峰时（工作日才峰；周末则全是空闲价），两种情况的金额不同，所以按桶判
const hour15 = withEstimate.hours[15];
const priceHit = isPeakAt(target, 15) ? 0.04 : 0.02;
const priceMiss = isPeakAt(target, 15) ? 2 : 1;
// Trae：推算命中 + 其余未命中；WB：90K 命中 + 10K 未命中
const expectedCny =
  (expectedAssumed / 1e6) * priceHit + ((100000 - expectedAssumed) / 1e6) * priceMiss + (90000 / 1e6) * priceHit + (10000 / 1e6) * priceMiss;
check('这一小时的钱按「Trae 推算 + WorkBuddy 实测」算', Math.abs(hour15.cost.cny - expectedCny) < 1e-9, true);
check('推算缓存列 = 推算量 + WB 实测 90K', hour15.cachedTokens, expectedAssumed + 90000);
check('其中推算量单独报出来', hour15.assumedCachedTokens, expectedAssumed);
check('别的通道报真值就不推算（WB 的 90K 是实测）', hour15.cost.cacheHit, expectedAssumed + 90000);

// 上游报了真值的 Trae 记录 → 真值优先，不再推算
insertUsage({ ts: at(16), provider: 'trae', account: 'tr-9', model: 't', credit: null, promptTokens: 100000, cachedTokens: 50000, completionTokens: 0, status: 200 });
const realValue = usageHourly(TARGET_KEY);
check('报了真值的那条不推算（推算量不变）', realValue.totals.cost.assumedCachedTokens, expectedAssumed);
check('16 点那格按真值 50K 算', realValue.hours[16].cachedTokens, 50000);
check('16 点没有推算量', realValue.hours[16].assumedCachedTokens, 0);

// 窗口里没有可对比的实测数据时，回落到 98%
const onlyTrae = usageHourly(TARGET_KEY, { account: 'tr-9' });
check('只查 Trae 时没有实测率，用兜底 98%', onlyTrae.totals.assumedCachedTokens, 98000);

// 先关库再删临时目录：Windows 上删不掉一个被打开的文件（EPERM）。
const { closeDb } = await import('../src/shared/db.ts');
closeDb();
fs.rmSync(tempData, { recursive: true, force: true });
console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
