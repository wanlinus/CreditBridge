import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-pricing-'));
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
function near(actual, expected, tolerance = 1e-9) {
  return typeof actual === 'number' && Math.abs(actual - expected) < tolerance;
}

function bj(iso) {
  return new Date(iso).getTime();
}

const M = await import('../src/shared/deepseek-pricing.ts');

console.log('--- 1. 价目表（2026-11-13 官方中文页）---');
check('默认模型是 deepseek-flash', M.DEFAULT_PRICING_MODEL, 'deepseek-flash');
check('高峰命中 0.04 元', M.DEEPSEEK_PEAK_PRICES['deepseek-flash'].inputCacheHit, 0.04);
check('高峰未命中 2 元', M.DEEPSEEK_PEAK_PRICES['deepseek-flash'].inputCacheMiss, 2);
check('高峰输出 8 元', M.DEEPSEEK_PEAK_PRICES['deepseek-flash'].output, 8);
check('未命中是命中的 50 倍', M.DEEPSEEK_PEAK_PRICES['deepseek-flash'].inputCacheMiss / M.DEEPSEEK_PEAK_PRICES['deepseek-flash'].inputCacheHit, 50);
check('币种是人民币', M.CURRENCY, 'CNY');

console.log('\n--- 2. 峰谷判断 ---');
check('周五 09:00 是高峰（左闭）', M.isPeakHour(bj('2026-11-13T09:00:00+08:00')), true);
check('周五 11:59 是高峰', M.isPeakHour(bj('2026-11-13T11:59:00+08:00')), true);
check('周五 12:00 已是空闲（右开）', M.isPeakHour(bj('2026-11-13T12:00:00+08:00')), false);
check('周五 13:00 空闲', M.isPeakHour(bj('2026-11-13T13:00:00+08:00')), false);
check('周五 14:00 是高峰（左闭）', M.isPeakHour(bj('2026-11-13T14:00:00+08:00')), true);
check('周五 17:59 是高峰', M.isPeakHour(bj('2026-11-13T17:59:00+08:00')), true);
check('周五 18:00 已是空闲（右开）', M.isPeakHour(bj('2026-11-13T18:00:00+08:00')), false);
check('周五 08:59 空闲', M.isPeakHour(bj('2026-11-13T08:59:00+08:00')), false);
check('周六 10:00 空闲', M.isPeakHour(bj('2026-11-14T10:00:00+08:00')), false);
check('周日 15:00 空闲', M.isPeakHour(bj('2026-11-15T15:00:00+08:00')), false);
check('周一 10:00 是高峰', M.isPeakHour(bj('2026-11-16T10:00:00+08:00')), true);

console.log('\n--- 3. 缓存是 prompt 的子集 ---');
let r = M.estimateCost({ promptTokens: 1_000_000, cachedTokens: 900_000, completionTokens: 0 }, 'deepseek-flash', bj('2026-11-13T10:00:00+08:00'));
check('cacheHit 就是传入的 cached', r.cacheHit, 900_000);
check('cacheMiss = prompt − cached', r.cacheMiss, 100_000);
check('高峰价 0.236 元', near(r.cny, 0.236), true);
check('全高峰时 offPeakCny 为 0', r.offPeakCny, 0);
check('peakTokens = 输入 + 输出', r.peakTokens, 1_000_000);

r = M.estimateCost({ promptTokens: 1_000_000, cachedTokens: 900_000, completionTokens: 0 }, 'deepseek-flash', bj('2026-11-13T22:00:00+08:00'));
check('空闲价是高峰的一半', near(r.cny, 0.118), true);
check('空闲时 peakCny 为 0', r.peakCny, 0);

console.log('\n--- 4. cached 异常大于 prompt ---');
r = M.estimateCost({ promptTokens: 100, cachedTokens: 500, completionTokens: 0 }, 'deepseek-flash', bj('2026-11-13T10:00:00+08:00'));
check('cached 被夹到 prompt', r.cacheHit, 100);
check('未命中不为负', r.cacheMiss, 0);

console.log('\n--- 5. 输出价 ---');
r = M.estimateCost({ completionTokens: 1_000_000 }, 'deepseek-flash', bj('2026-11-13T10:00:00+08:00'));
check('高峰 1M 输出 = 8 元', near(r.cny, 8), true);
r = M.estimateCost({ completionTokens: 1_000_000 }, 'deepseek-flash', bj('2026-11-13T22:00:00+08:00'));
check('空闲 1M 输出 = 4 元', near(r.cny, 4), true);

console.log('\n--- 6. 缺字段与未知模型 ---');
check('全缺时费用 0 不是 NaN', M.estimateCost({}).cny, 0);
check('全 null 时费用 0', M.estimateCost({ promptTokens: null, cachedTokens: null, completionTokens: null }).cny, 0);
check('未知模型返回 null', M.estimateCost({ promptTokens: 1 }, 'no-such-model'), null);

console.log('\n--- 7. 逐条记录分峰谷计价（仪表真正用的入口）---');
const records = [
  { ts: bj('2026-11-13T10:00:00+08:00'), promptTokens: 1_000_000, cachedTokens: 1_000_000, completionTokens: 0 },
  { ts: bj('2026-11-13T22:00:00+08:00'), promptTokens: 1_000_000, cachedTokens: 1_000_000, completionTokens: 0 },
];
r = M.estimateCostOfRecords(records);
check('合计 = 高峰 0.04 + 空闲 0.02', near(r.cny, 0.06), true);
check('高峰部分 0.04', near(r.peakCny, 0.04), true);
check('空闲部分 0.02', near(r.offPeakCny, 0.02), true);
check('高峰 token 数只算那条高峰的', r.peakTokens, 1_000_000);
check('空闲 token 数只算那条空闲的', r.offPeakTokens, 1_000_000);

const allPeak = M.estimateCostOfRecords(
  records.map((rec) => ({ ...rec, ts: bj('2026-11-13T10:00:00+08:00') })),
);
check('统一按高峰算会多算出 0.08（反证必须逐条算）', near(allPeak.cny, 0.08), true);

const empty = M.estimateCostOfRecords([]);
check('空记录集合返回全 0', empty.cny === 0 && empty.peakTokens === 0, true);

console.log('\n--- 8. formatCny ---');
check('¥2.48', M.formatCny(2.4778), '¥2.48');
check('小额给 3 位', M.formatCny(0.0421), '¥0.042');
check('0 显示 ¥0', M.formatCny(0), '¥0');
check('非数字是 —', M.formatCny(null), '—');

fs.rmSync(tempData, { recursive: true, force: true });
console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
