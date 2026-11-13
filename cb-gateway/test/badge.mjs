import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-gw-badge-'));
process.env.QB_DATA_DIR = tempData;

const NOW = Date.now();
const DAY = 86400000;
const records = [
  { ts: NOW, account: 'fk-1', provider: 'fake', model: 'm', credit: 5, promptTokens: 100, completionTokens: 50 },
  { ts: NOW, account: 'fk-2', provider: 'fake', model: 'free', credit: 0, promptTokens: 192000, completionTokens: 0 },
  { ts: NOW, account: 'fk-3', provider: 'fake', model: 'x' },
  { ts: NOW - DAY, account: 'fk-4', provider: 'fake', model: 'y', credit: 9 },
];
fs.writeFileSync(path.join(tempData, 'usage.jsonl'), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);

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

console.log('\n--- 3. 通道自述没有余额接口 ---');
badge = await buildBadge(fakeChannel({ creditsOf: async () => ({ provider: 'fake', supported: false, totalRemain: 0 }) }), fakeAccount('fk-1'));
check('显示「已连接」', badge.amount, '已连接');

console.log('\n--- 4. 今日文案 ---');
badge = await buildBadge(fakeChannel(), fakeAccount('fk-1'));
check('有积分就显示积分', badge.today, '今日 5');

badge = await buildBadge(fakeChannel(), fakeAccount('fk-2'));
check('免费模型显示 token 而不是「今日 0」', badge.today, '今日 192K tok');

badge = await buildBadge(fakeChannel(), fakeAccount('fk-3'));
check('既没积分也没 token 时显示次数', badge.today, '今日 1 次');

badge = await buildBadge(fakeChannel(), fakeAccount('fk-4'));
check('今天没有记录就不显示', badge.today, '');

console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail} 项失败`);
assert.equal(fail, 0);
