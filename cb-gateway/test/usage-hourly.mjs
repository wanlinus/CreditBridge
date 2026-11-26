// 单日 24 小时视图（usageHourly）：小时错位、跨天漏一条、费用按整天峰谷算——都是「不报错只错数字」。时区断言是 2026-11-26 的回归保护，不能删。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, section, done } from './_helpers.mjs';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-gw-hourly-'));
process.env.QB_DATA_DIR = tempData;

const { insertUsage, usagePricingRows } = await import('../src/store/usage.ts');
const { usageHourly } = await import('../src/ledger.ts');
const { measuredCacheHitRate } = await import('../src/shared/deepseek-pricing.ts');

/** 北京时间的日历日 `YYYY-MM-DD`——和被测代码同口径，本地 getDate() 在 UTC 进程会偏 8 小时（2026-11-26 CI 红 13 项）。 */
const dayKey = (d) => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const pick = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
};

/** 北京时间「今天」往前推 n 天，取那天 0 点（毫秒）。 */
function beijingMidnightDaysAgo(days) {
  const [y, m, d] = dayKey(new Date()).split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d - days));
  const key = `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
  return new Date(`${key}T00:00:00+08:00`).getTime();
}

// 用「3 天前」避开今天还没过完的边界。
const TARGET_START = beijingMidnightDaysAgo(3);
const TARGET_DAY = new Date(TARGET_START + 8 * 3600000); // 只为读 getUTCDay
const TARGET_KEY = dayKey(new Date(TARGET_START));
const at = (hour, minute = 30) => TARGET_START + hour * 3600000 + minute * 60000;

/** 独立复述峰谷规则：工作日 9-12、14-18，星期几按北京时间取。 */
const isPeakAt = (_day, hour) => {
  const wd = TARGET_DAY.getUTCDay();
  return wd >= 1 && wd <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
};

const rows = [
  { ts: at(0), provider: 'workbuddy', account: 'wb-1', model: 'm', credit: 1, promptTokens: 1000, completionTokens: 10, cachedTokens: 900, status: 200 },
  { ts: at(9), provider: 'workbuddy', account: 'wb-1', model: 'm', credit: 2, promptTokens: 2000, completionTokens: 20, cachedTokens: 0, status: 200 },
  { ts: at(12), provider: 'workbuddy', account: 'wb-2', model: 'm', credit: 3, promptTokens: 3000, completionTokens: 30, status: 499 },
  { ts: at(23), provider: 'qoder', account: 'qd-1', model: 'q', credit: 4, promptTokens: 4000, completionTokens: 40, status: 200 },
  { ts: at(9) - 86400000, provider: 'workbuddy', account: 'wb-1', model: 'm', credit: 100, promptTokens: 99999, status: 200 },
];
for (const row of rows) insertUsage(row);

const day = usageHourly(TARGET_KEY);

section('1. 形状与小时归属');
check('hours 恒 24 项、hour 0..23 升序', [day.hours.length, day.hours.map((h) => h.hour)], [24, Array.from({ length: 24 }, (_, i) => i)]);
check('date 原样回显', day.date, TARGET_KEY);
check('weekday / isPeakDay 按北京时间', [day.weekday, day.isPeakDay], [TARGET_DAY.getUTCDay(), TARGET_DAY.getUTCDay() >= 1 && TARGET_DAY.getUTCDay() <= 5]);
check('0/9/12/23 点各一格（12 点边界外仍算这天）', [day.hours[0].requests, day.hours[0].tokens, day.hours[9].requests, day.hours[9].tokens, day.hours[12].requests, day.hours[23].requests], [1, 1010, 1, 2020, 1, 1]);
check('没记录的小时补 0（不是缺项）', [day.hours[1].requests, day.hours[1].tokens, day.hours[1].cost.cny], [0, 0, 0]);
check('前一天那条没混进来', [day.totals.requests, day.totals.tokens, day.totals.cachedTokens], [4, 1010 + 2020 + 3030 + 4040, 900]);

section('2. 费用逐条按自己的时刻分峰谷');
check('9 点 peak 与规则一致', day.hours[9].peak, isPeakAt(TARGET_DAY, 9));
check('23 点永远不是峰时、费用全在空闲档', [day.hours[23].peak, day.hours[23].cost.peakCny, day.hours[23].cost.offPeakCny > 0], [false, 0, true]);
check('9 点的峰谷档', isPeakAt(TARGET_DAY, 9)
  ? [day.hours[9].cost.peakCny > 0, day.hours[9].cost.offPeakCny]
  : [day.hours[9].cost.peakCny, day.hours[9].cost.offPeakCny > 0], isPeakAt(TARGET_DAY, 9) ? [true, 0] : [0, true]);
const hourCostSum = day.hours.reduce((s, h) => s + h.cost.cny, 0);
check('合计 = 24 小时之和、峰谷拆分对得上', [Math.abs(day.totals.cost.cny - hourCostSum) < 1e-9, Math.abs(day.totals.cost.cny - (day.totals.cost.peakCny + day.totals.cost.offPeakCny)) < 1e-9], [true, true]);

section('3. 按账号收窄');
const only = usageHourly(TARGET_KEY, { account: 'wb-1' });
check('只算 wb-1 的两条', [only.totals.requests, only.totals.tokens], [2, 1010 + 2020]);
check('没命中的小时仍是 0', only.hours[23].requests, 0);

section('4. 非法日期与未来');
const throws = (fn) => { try { fn(); return 'no-error'; } catch (error) { return error.message; } };
check('格式不对被拒', throws(() => usageHourly('2026/11/13')).includes('YYYY-MM-DD'), true);
check('不存在的日子被拒（不被进位成 3 月 2 日）', throws(() => usageHourly('2026-02-30')).includes('不是合法日期'), true);
check('13 月被拒', throws(() => usageHourly('2026-13-01')).includes('不是合法日期'), true);
const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
check('未来的日子被拒', throws(() => usageHourly(dayKey(tomorrow))).includes('未来'), true);

section('5. 空数据的一天');
const empty = usageHourly(dayKey(new Date(TARGET_START - 10 * 86400000)));
check('没有记录的那天也回 24 项、全 0', [empty.hours.length, empty.totals.requests, empty.totals.tokens, empty.totals.cost.cny], [24, 0, 0, 0]);

section('6. Trae 缓存按其他通道实测平均推算');
// WorkBuddy 100K 输入 90K 命中 → 实测率 90%；Trae 100K 输入不报 → 按 90% 推 90K。
insertUsage({ ts: at(15), provider: 'trae', account: 'tr-9', model: 't', credit: null, promptTokens: 100000, completionTokens: 0, status: 200 });
insertUsage({ ts: at(15), provider: 'workbuddy', account: 'wb-9', model: 'w', credit: null, promptTokens: 100000, cachedTokens: 90000, completionTokens: 0, status: 200 });

const withEstimate = usageHourly(TARGET_KEY);
// 实测率按同一份数据自己算，断言「推算 = prompt × 实测率」这条规则，不写死魔法数字。
const rate = measuredCacheHitRate(usagePricingRows({}, TARGET_START, TARGET_START + 86400000));
const expectedAssumed = Math.floor(100000 * rate);
check('实测率算得出来、Trae 输入按它推算', [typeof rate, withEstimate.totals.cost.assumedCachedTokens], ['number', expectedAssumed]);
const hour15 = withEstimate.hours[15];
const priceHit = isPeakAt(TARGET_DAY, 15) ? 0.04 : 0.02;
const priceMiss = isPeakAt(TARGET_DAY, 15) ? 2 : 1;
const expectedCny = (expectedAssumed / 1e6) * priceHit + ((100000 - expectedAssumed) / 1e6) * priceMiss + (90000 / 1e6) * priceHit + (10000 / 1e6) * priceMiss;
check('这一小时的钱按 Trae 推算 + WB 实测算', Math.abs(hour15.cost.cny - expectedCny) < 1e-9, true);
check('推算缓存列与 cacheHit（= 推算 + WB 实测 90K）', [hour15.cachedTokens, hour15.assumedCachedTokens, hour15.cost.cacheHit], [expectedAssumed + 90000, expectedAssumed, expectedAssumed + 90000]);

// 上游报了真值 → 真值优先，不再推算
insertUsage({ ts: at(16), provider: 'trae', account: 'tr-9', model: 't', credit: null, promptTokens: 100000, cachedTokens: 50000, completionTokens: 0, status: 200 });
const realValue = usageHourly(TARGET_KEY);
check('报了真值的那条不推算', [realValue.totals.cost.assumedCachedTokens, realValue.hours[16].cachedTokens, realValue.hours[16].assumedCachedTokens], [expectedAssumed, 50000, 0]);

// 窗口里没有可对比的实测数据时回落到 98%
check('只查 Trae 时用兜底 98%', usageHourly(TARGET_KEY, { account: 'tr-9' }).totals.assumedCachedTokens, 98000);

const { closeDb } = await import('../src/shared/db.ts');
closeDb();
fs.rmSync(tempData, { recursive: true, force: true });
done();
