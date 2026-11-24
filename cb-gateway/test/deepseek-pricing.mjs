// DeepSeek 价目折算的自测（人民币 + 峰谷分档）。
//
// 钉住两件容易错、且**错了不会报错**的事：
//   1. 缓存是 `prompt` 的**子集**（要减，不能加）。命中价 0.04 元、未命中 2 元，
//      差 50 倍；这台机器实测命中率 98.8%，算反了不是小数误差，是差一个数量级。
//   2. 高峰/空闲价**差一倍**，而一天的用量跨好几个小时——必须按每条记录自己的
//      时间戳分别计价，统一套一个价会把费用算成两倍或一半。
//
// 价目来源（2026-11-13 抓取）：
//   https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
//   deepseek-flash（元/百万 tokens）：
//               缓存命中   缓存未命中   输出
//     空闲        0.02        1          4
//     高峰        0.04        2          8
//   「北京时间周一至周五（不含中国法定节假日）9:00-12:00、14:00-18:00 为高峰时段」
//
// 跑：node test/deepseek-pricing.mjs
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
/** 浮点比较（金额是小数）。 */
function near(actual, expected, tolerance = 1e-9) {
  return typeof actual === 'number' && Math.abs(actual - expected) < tolerance;
}

/** 构造一个「北京时间某天某点」的时间戳——`isPeakHour` 按本地时间判断，容器是 CST。 */
function bj(iso) {
  // 输入形如 '2026-11-13T10:00:00+08:00'
  return new Date(iso).getTime();
}

const M = await import('../src/shared/deepseek-pricing.ts');

// ---- 1. 价目表（人民币） ----
console.log('--- 1. 价目表（2026-11-13 官方中文页）---');
check('默认模型是 deepseek-flash', M.DEFAULT_PRICING_MODEL, 'deepseek-flash');
check('高峰命中 0.04 元', M.DEEPSEEK_PEAK_PRICES['deepseek-flash'].inputCacheHit, 0.04);
check('高峰未命中 2 元', M.DEEPSEEK_PEAK_PRICES['deepseek-flash'].inputCacheMiss, 2);
check('高峰输出 8 元', M.DEEPSEEK_PEAK_PRICES['deepseek-flash'].output, 8);
check('未命中是命中的 50 倍', M.DEEPSEEK_PEAK_PRICES['deepseek-flash'].inputCacheMiss / M.DEEPSEEK_PEAK_PRICES['deepseek-flash'].inputCacheHit, 50);
// 2026-11-13 定：折合费用一律按 flash 计价，不按模型分档。价目表多出一档就说明
// 有人加了「按模型算」——那需要一张跨通道的模型映射，得先想清楚，不能默默加进来。
check('价目表只有 flash 一档', Object.keys(M.DEEPSEEK_PEAK_PRICES), ['deepseek-flash']);
check('币种是人民币', M.CURRENCY, 'CNY');

// ---- 2. 峰谷判断（北京时间工作日 9-12 / 14-18）----
console.log('\n--- 2. 峰谷判断 ---');
// 2026-11-13 是周五
check('周五 09:00 是高峰（左闭）', M.isPeakHour(bj('2026-11-13T09:00:00+08:00')), true);
check('周五 11:59 是高峰', M.isPeakHour(bj('2026-11-13T11:59:00+08:00')), true);
check('周五 12:00 已是空闲（右开）', M.isPeakHour(bj('2026-11-13T12:00:00+08:00')), false);
check('周五 13:00 空闲', M.isPeakHour(bj('2026-11-13T13:00:00+08:00')), false);
check('周五 14:00 是高峰（左闭）', M.isPeakHour(bj('2026-11-13T14:00:00+08:00')), true);
check('周五 17:59 是高峰', M.isPeakHour(bj('2026-11-13T17:59:00+08:00')), true);
check('周五 18:00 已是空闲（右开）', M.isPeakHour(bj('2026-11-13T18:00:00+08:00')), false);
check('周五 08:59 空闲', M.isPeakHour(bj('2026-11-13T08:59:00+08:00')), false);
// 周末全天空闲
check('周六 10:00 空闲', M.isPeakHour(bj('2026-11-14T10:00:00+08:00')), false);
check('周日 15:00 空闲', M.isPeakHour(bj('2026-11-15T15:00:00+08:00')), false);
// 周一
check('周一 10:00 是高峰', M.isPeakHour(bj('2026-11-16T10:00:00+08:00')), true);

// ---- 3. 缓存是 prompt 的子集（减，不能加）----
console.log('\n--- 3. 缓存是 prompt 的子集 ---');
// 高峰：1M 输入，0.9M 命中 → 0.9×0.04 + 0.1×2 = 0.036 + 0.2 = 0.236
let r = M.estimateCost({ promptTokens: 1_000_000, cachedTokens: 900_000, completionTokens: 0 }, 'deepseek-flash', bj('2026-11-13T10:00:00+08:00'));
check('cacheHit 就是传入的 cached', r.cacheHit, 900_000);
check('cacheMiss = prompt − cached', r.cacheMiss, 100_000);
check('高峰价 0.236 元', near(r.cny, 0.236), true);
check('全高峰时 offPeakCny 为 0', r.offPeakCny, 0);
check('peakTokens = 输入 + 输出', r.peakTokens, 1_000_000);

// 空闲价正好一半
r = M.estimateCost({ promptTokens: 1_000_000, cachedTokens: 900_000, completionTokens: 0 }, 'deepseek-flash', bj('2026-11-13T22:00:00+08:00'));
check('空闲价是高峰的一半', near(r.cny, 0.118), true);
check('空闲时 peakCny 为 0', r.peakCny, 0);

// ---- 4. 防御：cached 超过 prompt ----
console.log('\n--- 4. cached 异常大于 prompt ---');
r = M.estimateCost({ promptTokens: 100, cachedTokens: 500, completionTokens: 0 }, 'deepseek-flash', bj('2026-11-13T10:00:00+08:00'));
check('cached 被夹到 prompt', r.cacheHit, 100);
check('未命中不为负', r.cacheMiss, 0);

// ---- 5. 输出单独计价 ----
console.log('\n--- 5. 输出价 ---');
r = M.estimateCost({ completionTokens: 1_000_000 }, 'deepseek-flash', bj('2026-11-13T10:00:00+08:00'));
check('高峰 1M 输出 = 8 元', near(r.cny, 8), true);
r = M.estimateCost({ completionTokens: 1_000_000 }, 'deepseek-flash', bj('2026-11-13T22:00:00+08:00'));
check('空闲 1M 输出 = 4 元', near(r.cny, 4), true);

// ---- 6. 缺字段 / 未知模型 ----
console.log('\n--- 6. 缺字段与未知模型 ---');
check('全缺时费用 0 不是 NaN', M.estimateCost({}).cny, 0);
check('全 null 时费用 0', M.estimateCost({ promptTokens: null, cachedTokens: null, completionTokens: null }).cny, 0);
check('未知模型返回 null', M.estimateCost({ promptTokens: 1 }, 'no-such-model'), null);

// ---- 7. 多条记录按各自时间戳分别计价 ----
console.log('\n--- 7. 逐条记录分峰谷计价（仪表真正用的入口）---');
// 两条各 1M 输入、全命中：一条高峰（0.04），一条空闲（0.02）
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

// **反证**：如果统一按高峰算，会是 0.08（多算 33%）
const allPeak = M.estimateCostOfRecords(
  records.map((rec) => ({ ...rec, ts: bj('2026-11-13T10:00:00+08:00') })),
);
check('统一按高峰算会多算出 0.08（反证必须逐条算）', near(allPeak.cny, 0.08), true);

// 空数组 → 全 0，不是 null
const empty = M.estimateCostOfRecords([]);
check('空记录集合返回全 0', empty.cny === 0 && empty.peakTokens === 0, true);

// ---- 7.5 缓存推算（Trae 不报缓存）----
//
// 2026-11-13 抓 Trae 自己客户端的 token_usage：同一个会话连发两次，`cache_read_input_tokens`
// 和 `cache_creation_input_tokens` 都是 0。所以 Trae 的缓存量**按其他通道的实测平均推算**。
// 这一组钉四件事：加权口径、只算报了数的行、真值优先、**推算量必须能被数出来**。
console.log('\n--- 7.5 缓存推算 ---');
check('只有 Trae 在推算名单里', M.CACHE_ESTIMATED_PROVIDERS, ['trae']);
check('兜底比例是 98%', M.CACHE_ESTIMATE_FALLBACK_RATE, 0.98);

// 实测平均：按 token 加权，不是各通道平均
const rows = [
  { provider: 'workbuddy', promptTokens: 100_000, cachedTokens: 90_000 }, // 90%
  { provider: 'loomy', promptTokens: 1_000_000, cachedTokens: 990_000 }, // 99%
  { provider: 'trae', promptTokens: 500_000, cachedTokens: 0 }, // 被排除
];
const rate = M.measuredCacheHitRate(rows);
check('排除 Trae、按 token 加权', Math.round(rate * 1e6) / 1e6, 0.981818);
// 若是各通道简单平均会是 (0.9 + 0.99) / 2 = 0.945，明显不同——这就是加权与平均的区别
check('不是各通道简单平均', Math.round(rate * 1e6) / 1e6 !== 0.945, true);

// 上游没报（null）的行不进分母：拿 0 计入会把平均压低
const withNull = M.measuredCacheHitRate([
  { provider: 'workbuddy', promptTokens: 100_000, cachedTokens: 100_000 },
  { provider: 'workbuddy', promptTokens: 900_000, cachedTokens: null },
]);
check('cached 为 null 的行不计入分母', withNull, 1);

// 没有任何实测数据时返回 null（调用方用兜底比例）
check('没有可对比数据时返回 null', M.measuredCacheHitRate([{ provider: 'trae', promptTokens: 1000, cachedTokens: 0 }]), null);

// 上游报了 0 → 按传入的平均率推算
let eff = M.cachedForPricing('trae', 100_000, 0, 0.99);
check('Trae 报 0 时按传入的平均率推算', eff, { cached: 99000, assumed: 99000 });
// 上游没报（null）→ 同样推算
eff = M.cachedForPricing('trae', 100_000, null, 0.99);
check('Trae 没报时也推算', eff, { cached: 99000, assumed: 99000 });
// 上游报了真值 → 真值优先，绝不覆盖
eff = M.cachedForPricing('trae', 100_000, 61_234, 0.99);
check('Trae 报了真值就用真值', eff, { cached: 61234, assumed: 0 });
// 别的通道不受影响
eff = M.cachedForPricing('workbuddy', 100_000, 0, 0.99);
check('别的通道报 0 就是 0（不推算）', eff, { cached: 0, assumed: 0 });
// 没有实测率时用兜底 98%
check('没传平均率时用兜底 98%', M.cachedForPricing('trae', 100_000, 0), { cached: 98000, assumed: 98000 });
// 边界：prompt 为 0 / 负数
check('prompt 为 0 时推算也是 0', M.cachedForPricing('trae', 0, 0, 0.99), { cached: 0, assumed: 0 });

// 计价真的按推算算：Trae 100K 输入、空闲价，命中 99% → 99K×0.02/M + 1K×1/M
//
// 注意传入形状：`cachedTokens` 是**生效值**（`pricingRows()` 已经把推算套进去了），
// `assumedCached` 只用来把「其中多少是推算的」报出来。两者由调用方保持一致。
const assumedCost = M.estimateCostOfRecords([
  { ts: bj('2026-11-13T22:00:00+08:00'), promptTokens: 100_000, cachedTokens: 99_000, completionTokens: 0, assumedCached: 99_000 },
]);
check('推算之后费用按命中价算', near(assumedCost.cny, (99_000 / 1e6) * 0.02 + (1_000 / 1e6) * 1, 1e-9), true);
check('推算的 token 数被单独报出来', assumedCost.assumedCachedTokens, 99_000);
// 不传 assumedCached 时（真数据路径）就是 0
const noAssumption = M.estimateCostOfRecords([
  { ts: bj('2026-11-13T22:00:00+08:00'), promptTokens: 100_000, cachedTokens: 0, completionTokens: 0 },
]);
check('没有推算标记时 assumedCachedTokens 是 0', noAssumption.assumedCachedTokens, 0);
check('没有推算时全按未命中算', near(noAssumption.cny, 0.1, 1e-9), true);

// ---- 8. 金额格式化 ----
console.log('\n--- 8. formatCny ---');
check('¥2.48', M.formatCny(2.4778), '¥2.48');
check('小额给 3 位', M.formatCny(0.0421), '¥0.042');
check('0 显示 ¥0', M.formatCny(0), '¥0');
check('非数字是 —', M.formatCny(null), '—');

// 先关库再删临时目录：Windows 上删不掉一个被打开的文件（EPERM）。
const { closeDb } = await import('../src/shared/db.ts');
closeDb();
fs.rmSync(tempData, { recursive: true, force: true });
console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
