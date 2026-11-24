// 徽标文案的组装回归测试。
//
// ## 为什么这段逻辑在网关、而且要测
//
// 徽标上那两行字（主数字 + 「今日 X」）曾经由前端自己算，于是每加一个计费方式
// 不同的通道就要改一次插件，漏了就静默显示错的东西。搬到 `core/badge.ts` 之后，
// 规则集中在一处，这里把四条分支钉死：
//
//   1. 有余额 → 主数字是余额（100 以上取整，以下保留三位小数）；
//   2. 余额取不到 → 显示「—」并带出 reason（**不编 0**，那是假数据）；
//   3. 通道没有余额接口（`supported: false`）→ 「已连接」，链路是通的；
//   4. 「今日」的取舍：有积分显示积分，积分为 0 但有 token 显示 token，
//      两样都没有就只显示次数——**免费模型（credit 0）是真实存在的**，
//      一直显示「今日 0」等于什么都没说（2026-11-10 用户就是这么问的）。
//
// 跑：node test/badge.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-gw-badge-'));
process.env.QB_DATA_DIR = tempData;

// v4 起读数走 SQLite：造数据写 `usage_record` 表（见 private/docs/v4/README.md §5.1）。
const { insertUsage } = await import('../src/store/usage.ts');

const NOW = Date.now();
const DAY = 86400000;
const records = [
  // fk-1：今天花了 5 积分
  { ts: NOW, account: 'fk-1', provider: 'fake', model: 'm', credit: 5, promptTokens: 100, completionTokens: 50 },
  // fk-2：免费模型（credit 0）但吃了 192K token → 该显示 token 而不是「今日 0」
  { ts: NOW, account: 'fk-2', provider: 'fake', model: 'free', credit: 0, promptTokens: 192000, completionTokens: 0 },
  // fk-3：既没积分也没 token → 只能显示次数
  { ts: NOW, account: 'fk-3', provider: 'fake', model: 'x' },
  // fk-4：今天没有记录（只有昨天的）→ 「今日」留空
  { ts: NOW - DAY, account: 'fk-4', provider: 'fake', model: 'y', credit: 9 },
];
for (const record of records) insertUsage(record);

const { buildBadge } = await import('../src/core/badge.ts');

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}\n      期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

/** 假通道：只填 `buildBadge` 会用到的那几项。 */
function fakeChannel(overrides = {}) {
  return {
    id: 'fake',
    idPrefix: 'fk',
    label: '假通道',
    identity: { clientVersion: '9.9.9' },
    modelsOf: async () => [],
    creditsOf: async () => ({ provider: 'fake', supported: true, totalRemain: 0 }),
    chatAs: async () => ({ kind: 'json', status: 200, body: {} }),
    ...overrides,
  };
}

function fakeAccount(id, overrides = {}) {
  return {
    id,
    channelId: 'fake',
    seq: 1,
    label: `账号${id.slice(-1)}`,
    credential: {},
    status: 'ready',
    cooldownUntil: null,
    statusMessage: null,
    profile: {},
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

// ---- 1. 主数字 ----
console.log('--- 1. 主数字（余额） ---');
let badge = await buildBadge(fakeChannel({ creditsOf: async () => ({ provider: 'fake', supported: true, totalRemain: 1550 }) }), fakeAccount('fk-1'));
check('100 以上取整', badge.amount, '1550');
check('title 是「通道 · 账号」', badge.title, '假通道 · 账号1');
check('channel 是通道 id（插件据此查图标）', badge.channel, 'fake');
check('没有 error 时 note 为 null', badge.note, null);

badge = await buildBadge(fakeChannel({ creditsOf: async () => ({ provider: 'fake', supported: true, totalRemain: 12.3456 }) }), fakeAccount('fk-1'));
check('100 以下保留三位小数', badge.amount, '12.346');

badge = await buildBadge(fakeChannel({ creditsOf: async () => ({ provider: 'fake', supported: true, totalRemain: 0.15 }) }), fakeAccount('fk-1'));
check('小额不被抹成 0', badge.amount, '0.15');

// ---- 2. 取不到余额 ----
console.log('\n--- 2. 取不到余额 ---');
badge = await buildBadge(
  fakeChannel({
    creditsOf: async () => {
      throw new Error('上游 503');
    },
  }),
  fakeAccount('fk-1'),
);
check('显示「—」而不是 0', badge.amount, '—');
check('原因带在 note 里', badge.note, '上游 503');

// ---- 3. 通道没有余额接口 ----
console.log('\n--- 3. 通道自述没有余额接口 ---');
badge = await buildBadge(fakeChannel({ creditsOf: async () => ({ provider: 'fake', supported: false, totalRemain: 0 }) }), fakeAccount('fk-1'));
check('显示「已连接」', badge.amount, '已连接');

// ---- 4. 今日文案 ----
console.log('\n--- 4. 今日文案 ---');
badge = await buildBadge(fakeChannel(), fakeAccount('fk-1'));
check('有积分就显示积分', badge.today, '今日 5');

// 免费模型：credit 为 0，但有 token。显示「今日 0」等于什么都不说。
badge = await buildBadge(fakeChannel(), fakeAccount('fk-2'));
check('免费模型显示 token 而不是「今日 0」', badge.today, '今日 192K tok');

badge = await buildBadge(fakeChannel(), fakeAccount('fk-3'));
check('既没积分也没 token 时显示次数', badge.today, '今日 1 次');

badge = await buildBadge(fakeChannel(), fakeAccount('fk-4'));
check('今天没有记录就不显示', badge.today, '');

console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail} 项失败`);
assert.equal(fail, 0);
