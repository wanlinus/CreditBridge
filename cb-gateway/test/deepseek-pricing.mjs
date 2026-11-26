// DeepSeek 价目折算：缓存是 prompt 的子集（要减不能加，价差 50 倍）、峰谷按每条记录自己的 ts 分别计价。错了不报错，只差一个数量级/一倍。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, section, done } from './_helpers.mjs';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-pricing-'));
process.env.QB_DATA_DIR = tempData;

const M = await import('../src/shared/deepseek-pricing.ts');

/** 构造「北京时间某天某点」的时间戳——isPeakHour 不读进程本地时区。 */
const bj = (iso) => new Date(iso).getTime();
const near = (actual, expected, tolerance = 1e-9) => typeof actual === 'number' && Math.abs(actual - expected) < tolerance;

section('1. 价目表（人民币）');
check('默认模型 deepseek-flash、币种 CNY', [M.DEFAULT_PRICING_MODEL, M.CURRENCY], ['deepseek-flash', 'CNY']);
check('高峰命中/未命中/输出价', [M.DEEPSEEK_PEAK_PRICES['deepseek-flash'].inputCacheHit, M.DEEPSEEK_PEAK_PRICES['deepseek-flash'].inputCacheMiss, M.DEEPSEEK_PEAK_PRICES['deepseek-flash'].output], [0.04, 2, 8]);
check('未命中是命中的 50 倍', M.DEEPSEEK_PEAK_PRICES['deepseek-flash'].inputCacheMiss / M.DEEPSEEK_PEAK_PRICES['deepseek-flash'].inputCacheHit, 50);
// 折合费用一律按 flash 计价；价目表多出一档 = 有人加了「按模型算」，那需要跨通道映射，不能默默加。
check('价目表只有 flash 一档', Object.keys(M.DEEPSEEK_PEAK_PRICES), ['deepseek-flash']);

section('2. 峰谷判断（北京时间工作日 9-12 / 14-18）');
// 一正一反边界：左闭右开。2026-11-13 是周五、11-14/15 是周末、11-16 是周一。
const peakCases = [
  ['周五 09:00 高峰（左闭）', '2026-11-13T09:00:00+08:00', true],
  ['周五 11:59 高峰', '2026-11-13T11:59:00+08:00', true],
  ['周五 12:00 空闲（右开）', '2026-11-13T12:00:00+08:00', false],
  ['周五 13:00 空闲', '2026-11-13T13:00:00+08:00', false],
  ['周五 14:00 高峰（左闭）', '2026-11-13T14:00:00+08:00', true],
  ['周五 17:59 高峰', '2026-11-13T17:59:00+08:00', true],
  ['周五 18:00 空闲（右开）', '2026-11-13T18:00:00+08:00', false],
  ['周五 08:59 空闲', '2026-11-13T08:59:00+08:00', false],
  ['周六 10:00 空闲', '2026-11-14T10:00:00+08:00', false],
  ['周日 15:00 空闲', '2026-11-15T15:00:00+08:00', false],
  ['周一 10:00 高峰', '2026-11-16T10:00:00+08:00', true],
];
for (const [name, iso, expected] of peakCases) check(name, M.isPeakHour(bj(iso)), expected);

section('3. 缓存是 prompt 的子集（减，不能加）');
let r = M.estimateCost({ promptTokens: 1_000_000, cachedTokens: 900_000, completionTokens: 0 }, 'deepseek-flash', bj('2026-11-13T10:00:00+08:00'));
check('cacheHit / cacheMiss = prompt − cached', [r.cacheHit, r.cacheMiss], [900_000, 100_000]);
check('高峰价 0.236 元、offPeakCny 0、peakTokens = 输入 + 输出', [near(r.cny, 0.236), r.offPeakCny, r.peakTokens], [true, 0, 1_000_000]);
r = M.estimateCost({ promptTokens: 1_000_000, cachedTokens: 900_000, completionTokens: 0 }, 'deepseek-flash', bj('2026-11-13T22:00:00+08:00'));
check('空闲价是高峰的一半、peakCny 0', [near(r.cny, 0.118), r.peakCny], [true, 0]);

section('4. 防御：cached 超过 prompt');
r = M.estimateCost({ promptTokens: 100, cachedTokens: 500, completionTokens: 0 }, 'deepseek-flash', bj('2026-11-13T10:00:00+08:00'));
check('cached 被夹到 prompt、未命中不为负', [r.cacheHit, r.cacheMiss], [100, 0]);

section('5. 输出单独计价');
r = M.estimateCost({ completionTokens: 1_000_000 }, 'deepseek-flash', bj('2026-11-13T10:00:00+08:00'));
check('高峰 1M 输出 8 元', near(r.cny, 8), true);
r = M.estimateCost({ completionTokens: 1_000_000 }, 'deepseek-flash', bj('2026-11-13T22:00:00+08:00'));
check('空闲 1M 输出 4 元', near(r.cny, 4), true);

section('6. 缺字段 / 未知模型');
check('全缺 / 全 null 费用 0 不是 NaN', [M.estimateCost({}).cny, M.estimateCost({ promptTokens: null, cachedTokens: null, completionTokens: null }).cny], [0, 0]);
check('未知模型返回 null', M.estimateCost({ promptTokens: 1 }, 'no-such-model'), null);

section('7. 多条记录按各自时间戳分别计价');
const records = [
  { ts: bj('2026-11-13T10:00:00+08:00'), promptTokens: 1_000_000, cachedTokens: 1_000_000, completionTokens: 0 },
  { ts: bj('2026-11-13T22:00:00+08:00'), promptTokens: 1_000_000, cachedTokens: 1_000_000, completionTokens: 0 },
];
r = M.estimateCostOfRecords(records);
check('合计 = 高峰 0.04 + 空闲 0.02', [near(r.cny, 0.06), near(r.peakCny, 0.04), near(r.offPeakCny, 0.02)], [true, true, true]);
check('高峰/空闲 token 只算各自那条', [r.peakTokens, r.offPeakTokens], [1_000_000, 1_000_000]);
// 反证：统一按高峰算会是 0.08（多算 33%）
const allPeak = M.estimateCostOfRecords(records.map((rec) => ({ ...rec, ts: bj('2026-11-13T10:00:00+08:00') })));
check('统一按高峰算会多算出 0.08', near(allPeak.cny, 0.08), true);
const empty = M.estimateCostOfRecords([]);
check('空记录集合返回全 0', empty.cny === 0 && empty.peakTokens === 0, true);

section('8. 缓存推算（Trae 不报缓存）');
check('推算名单 / 兜底比例', [M.CACHE_ESTIMATED_PROVIDERS, M.CACHE_ESTIMATE_FALLBACK_RATE], [['trae'], 0.98]);
const rows = [
  { provider: 'workbuddy', promptTokens: 100_000, cachedTokens: 90_000 },
  { provider: 'loomy', promptTokens: 1_000_000, cachedTokens: 990_000 },
  { provider: 'trae', promptTokens: 500_000, cachedTokens: 0 },
];
const rate = M.measuredCacheHitRate(rows);
check('排除 Trae、按 token 加权（不是简单平均）', [Math.round(rate * 1e6) / 1e6, Math.round(rate * 1e6) / 1e6 !== 0.945], [0.981818, true]);
check('cached 为 null 的行不计入分母', M.measuredCacheHitRate([
  { provider: 'workbuddy', promptTokens: 100_000, cachedTokens: 100_000 },
  { provider: 'workbuddy', promptTokens: 900_000, cachedTokens: null },
]), 1);
check('没有可对比数据时返回 null', M.measuredCacheHitRate([{ provider: 'trae', promptTokens: 1000, cachedTokens: 0 }]), null);
check('Trae 报 0 / 没报 都推算', [M.cachedForPricing('trae', 100_000, 0, 0.99), M.cachedForPricing('trae', 100_000, null, 0.99)], [{ cached: 99000, assumed: 99000 }, { cached: 99000, assumed: 99000 }]);
check('Trae 报了真值就用真值', M.cachedForPricing('trae', 100_000, 61_234, 0.99), { cached: 61234, assumed: 0 });
check('别的通道报 0 就是 0（不推算）', M.cachedForPricing('workbuddy', 100_000, 0, 0.99), { cached: 0, assumed: 0 });
check('没传平均率用兜底 98%、prompt 0 推算也是 0', [M.cachedForPricing('trae', 100_000, 0), M.cachedForPricing('trae', 0, 0, 0.99)], [{ cached: 98000, assumed: 98000 }, { cached: 0, assumed: 0 }]);
const assumedCost = M.estimateCostOfRecords([
  { ts: bj('2026-11-13T22:00:00+08:00'), promptTokens: 100_000, cachedTokens: 99_000, completionTokens: 0, assumedCached: 99_000 },
]);
check('推算之后费用按命中价算、推算量单独报', [near(assumedCost.cny, (99_000 / 1e6) * 0.02 + (1_000 / 1e6) * 1, 1e-9), assumedCost.assumedCachedTokens], [true, 99_000]);
const noAssumption = M.estimateCostOfRecords([
  { ts: bj('2026-11-13T22:00:00+08:00'), promptTokens: 100_000, cachedTokens: 0, completionTokens: 0 },
]);
check('没有推算标记时 assumedCachedTokens 0、全按未命中算', [noAssumption.assumedCachedTokens, near(noAssumption.cny, 0.1, 1e-9)], [0, true]);

section('9. formatCny');
check('¥2.48 / 小额 3 位 / 0 / 非数字', [M.formatCny(2.4778), M.formatCny(0.0421), M.formatCny(0), M.formatCny(null)], ['¥2.48', '¥0.042', '¥0', '—']);

const { closeDb } = await import('../src/shared/db.ts');
closeDb();
fs.rmSync(tempData, { recursive: true, force: true });
done();
