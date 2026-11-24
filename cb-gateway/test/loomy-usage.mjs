// Loomy 余额口径的自测。
//
// 钉住的是 2026-11-12 发现的那个「少显示四成」：`data.balance` 只是长期池，
// 当日赠送池在 `data.dailyBalance`，可用积分是两个之和（v1 还会直接回
// `availableBalance`）。只读 `balance` 不会报错，只会让徽标和面板一直偏小。
//
// 不依赖网络：把 `fetch` 换成假实现，逐种形状喂进去。
//
// 运行：node test/loomy-usage.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-loomy-usage-'));
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

const usage = await import('../src/channels/loomy/usage.ts');

const account = {
  id: 'lo-9',
  channelId: 'loomy',
  status: 'ready',
  credential: {
    session: 'a'.repeat(32),
    userId: 'u-1',
    phone: '13800000000',
    expiresAt: Date.now() + 86400_000,
    source: 'login',
  },
};

/** 让下一次请求回指定的 body。 */
let nextBody = null;
let nextStatus = 200;
globalThis.fetch = async () => ({
  ok: nextStatus >= 200 && nextStatus < 300,
  status: nextStatus,
  text: async () => JSON.stringify(nextBody),
});

async function run(body, status = 200) {
  nextBody = body;
  nextStatus = status;
  return usage.getLoomyCredits(account);
}

// ---- 1. 真实形状：v1 同时给 availableBalance / balance / dailyBalance ----
console.log('--- 1. v1 完整形状（实测 2026-11-12：5500 + 3595 = 9095）---');
let credits = await run({ code: '000000', data: { balance: 5500, dailyBalance: 3595, availableBalance: 9095, total: 142 } });
check('可用积分取 availableBalance', credits.totalRemain, 9095);
check('packages 一行', credits.packages.length, 1);
// **Loomy 没有「总额度」概念**（每日重置、不用作废），所以 limit 恒为 null，
// 不硬凑成「剩余 + 已用」——那个等式只在当日池刚重置时成立（见 usage.ts 的注释）。
check('limit 是 null（该通道不提供总额度）', credits.packages[0].limit, null);

// ---- 2. v2 形状：没有 availableBalance，要自己加 ----
console.log('\n--- 2. v2 形状（无 availableBalance）---');
credits = await run({ code: '000000', data: { balance: 5500, dailyBalance: 3595, total: 0 } });
check('没有 availableBalance 时用 balance + dailyBalance', credits.totalRemain, 9095);

// ---- 3. 只有 balance：不能变成 NaN ----
console.log('\n--- 3. 只有 balance ---');
credits = await run({ code: '000000', data: { balance: 1200 } });
check('只有 balance 时就用它', credits.totalRemain, 1200);

// ---- 4. dailyBalance 为 0 也要算对 ----
console.log('\n--- 4. 当日池为 0 ---');
credits = await run({ code: '000000', data: { balance: 1200, dailyBalance: 0 } });
check('当日 0 时等于 balance', credits.totalRemain, 1200);

// ---- 5. 兼容旧封装：data.data.balance ----
console.log('\n--- 5. 嵌套 data.data 形状 ---');
credits = await run({ code: '000000', data: { data: { balance: 777, dailyBalance: 0 } } });
check('嵌套一层也能读', credits.totalRemain, 777);

// ---- 6. 读不到有效数字必须抛错（不能静默给 0/NaN） ----
console.log('\n--- 6. 形状坏掉时抛错 ---');
let threw = '';
try {
  await run({ code: '000000', data: { nope: 1 } });
} catch (error) {
  threw = error.message;
}
check('没有可用数字时抛错', threw.includes('没返回有效 balance'), true);

// ---- 7. 余额缺失时也要带上账号信息（面板要用） ----
console.log('\n--- 7. account 字段 ---');
credits = await run({ code: '000000', data: { balance: 10, dailyBalance: 5 } });
check('account.uid 来自凭据', credits.account.uid, 'u-1');
check('account.domain 固定 loomy.xunfei.cn', credits.account.domain, 'loomy.xunfei.cn');

// ---- 8. 「今日已用」：从流水里挑出今天从当日池扣掉的分 ----
//
// Loomy 的当日池**每天重置为 5000**，「累计已用」对它不成立（见 private/docs/loomy-recon.md §4c），
// 所以只算今天。判据是 `dailyCycleDate` 而不是 `direction`：长期池的扣分记录没有那个字段。
// 早先这里的 `used` 是**写死的 0**，界面上永远显示「已用 0」，看起来像这个号没花过积分。
const { localDate } = await import('../src/shared/clock.ts');
const today = localDate();

console.log('\n--- 8. 今日已用（从流水算）---');
credits = await run({
  code: '000000',
  data: {
    balance: 0,
    dailyBalance: 3000,
    availableBalance: 3000,
    list: [
      { direction: 'debit', pointsActual: 500, dailyCycleDate: today },
      { direction: 'debit', pointsActual: 300, dailyCycleDate: today },
      { direction: 'debit', pointsActual: 999, dailyCycleDate: '2000-01-01' }, // 别的日子，不算
      { direction: 'credit', pointsActual: 200, dailyCycleDate: today }, // 加分不是消耗
      { direction: 'debit', pointsActual: 100 }, // 长期池的记录，没有 dailyCycleDate
    ],
  },
});
check('今日已用只算今天从当日池扣的', credits.packages[0].used, 800);
// limit 恒为 null：Loomy 没有「总额度」这个概念（见 usage.ts 的注释）。
check('limit 恒为 null，不硬凑', credits.packages[0].limit, null);

// 没有 list（或 list 为空）时不能崩，也要给出 0 而不是 NaN。
console.log('\n--- 9. 没有流水时 ---');
credits = await run({ code: '000000', data: { balance: 0, dailyBalance: 1200, availableBalance: 1200 } });
check('没有 list 时今日已用是 0', credits.packages[0].used, 0);
check('没有 list 时剩余照常读', credits.totalRemain, 1200);

// 先关库再删临时目录：Windows 上删不掉一个被打开的文件（EPERM）。
const { closeDb } = await import('../src/shared/db.ts');
closeDb();
fs.rmSync(tempData, { recursive: true, force: true });
console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
