// 概览页「全价 X」提示的判断逻辑。
//
// 钉住 2026-11-22 那次：一次 69 万 token 的全新请求花掉 1720 分（当天额度 5000），
// 而卡片上只显示「已用积分 2989」——**看不出这 2989 里绝大部分是白花的**。
//
// 根因不是网关算错账（账本 2989 分和上游一致），而是：
// 缓存是**前缀缓存**，首次出现的内容必然全价。「一次性塞几十万 token 全新内容」
// 和「在已有对话上追加一句」成本差几十倍，但这两件事在「已用积分」一个数上看不出区别。
//
// 所以加一个提示。这里钉住它的三条判断规则：
//   1. **按账号判断，不用全账号合计**——同一天 lo-1 命中 1.3%、wb-1 命中 99.8%，
//      合计只有 1.1% 未命中，真实异常被稀释，卡片上什么都不会显示；
//   2. **只对上游确实报了缓存的账号判断**——Trae 的 `cachedTokens` 恒为 0，
//      那是「没给这个数」，不是「全未命中」；把它算进来会把合计从 1.1% 抬到 28.7%
//      （凭空造出的假异常）；
//   3. 占比过半才提示，否则日常小请求会一直亮着。
//
// 数据全部取自 2026-11-22 线上真实账本，不是编的。
//
// 跑：node test/uncached-hint.mjs
import { UNCACHED_ALERT_RATIO, shouldWarnUncached, worstUncachedAccount } from '../web/src/utils/uncached.ts';

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

/** 2026-11-22 线上真实数据（`/api/usage` 的 `todayByAccount`）。 */
const LIVE = [
  { account: 'wb-1', promptTokens: 120828829, cachedTokens: 120681984 },
  { account: 'tr-4', promptTokens: 47328156, cachedTokens: 0 },
  { account: 'lo-1', promptTokens: 1195554, cachedTokens: 15040 },
];

// ---- 1. 按账号能揪出异常账号 ----
console.log('--- 1. 按账号判断（线上真实数据）---');
const worst = worstUncachedAccount(LIVE);
check('揪出 lo-1', worst?.account, 'lo-1');
check('未命中 token = prompt - cached', worst?.tokens, 1195554 - 15040);
check('占比约 98.7%', Math.round(worst.ratio * 1000) / 10, 98.7);
check('会触发提示', shouldWarnUncached(worst), true);

// ---- 2. 合计口径会漏掉它 ----
console.log('\n--- 2. 对照：合计口径漏掉真实异常 ---');
const honest = LIVE.filter((r) => r.cachedTokens > 0);
const sum = (list, key) => list.reduce((s, r) => s + r[key], 0);
const honestRatio = (sum(honest, 'promptTokens') - sum(honest, 'cachedTokens')) / sum(honest, 'promptTokens');
check('只算报缓存的账号，合计未命中仅 1.1%', Math.round(honestRatio * 1000) / 10, 1.1);
check('稀释后不触发提示', honestRatio < UNCACHED_ALERT_RATIO, true);

// ---- 3. 不报缓存的通道必须跳过 ----
console.log('\n--- 3. 不报缓存的通道（Trae）必须跳过 ---');
check('全是 cachedTokens=0 → 无从判断', worstUncachedAccount([{ account: 'tr-4', promptTokens: 47328156, cachedTokens: 0 }]), null);
check(
  '混在正常账号里也不影响结果',
  worstUncachedAccount([
    { account: 'tr-4', promptTokens: 47328156, cachedTokens: 0 },
    { account: 'wb-1', promptTokens: 120828829, cachedTokens: 120681984 },
  ])?.account,
  'wb-1',
);
// 这条解释为什么不能用合计：tr-4 的 4732 万会被当成全未命中
const allRatio = (sum(LIVE, 'promptTokens') - sum(LIVE, 'cachedTokens')) / sum(LIVE, 'promptTokens');
check('把 Trae 算进合计会虚报到 28.7%', Math.round(allRatio * 1000) / 10, 28.7);

// ---- 4. 正常账号不误报 ----
console.log('\n--- 4. 正常账号不误报 ---');
const normal = worstUncachedAccount([{ account: 'wb-1', promptTokens: 120828829, cachedTokens: 120681984 }]);
check('wb-1 未命中 0.1%', Math.round(normal.ratio * 1000) / 10, 0.1);
check('不触发提示', shouldWarnUncached(normal), false);

// ---- 5. 边界 ----
console.log('\n--- 5. 边界 ---');
check('空数组', worstUncachedAccount([]), null);
check('null', worstUncachedAccount(null), null);
check('undefined', worstUncachedAccount(undefined), null);
check('prompt 为 0 跳过', worstUncachedAccount([{ account: 'x', promptTokens: 0, cachedTokens: 0 }]), null);
check('cached 大于 prompt（脏数据）跳过', worstUncachedAccount([{ account: 'x', promptTokens: 100, cachedTokens: 200 }]), null);
check('shouldWarnUncached(null) 为 false', shouldWarnUncached(null), false);

// ---- 6. 阈值边界 ----
console.log('\n--- 6. 阈值边界（50%）---');
const at = (ratio) => worstUncachedAccount([{ account: 'x', promptTokens: 1000, cachedTokens: Math.round(1000 * (1 - ratio)) }]);
check('恰好 50% → 提示', shouldWarnUncached(at(0.5)), true);
check('49% → 不提示', shouldWarnUncached(at(0.49)), false);
check('51% → 提示', shouldWarnUncached(at(0.51)), true);

console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
