// 主动刷新积分（`POST /api/accounts/:id/credits` 和 `POST /api/channels/:id/credits` 背后的
// `core/credits.ts`）的行为。钉四件事：
//
//   1. **手动刷新必须绕过 30 秒缓存**——不然点了按钮数字不变，看起来像按钮坏了；
//   2. 读到的值要进缓存，下一次列表拉取不会立刻又打上游；
//   3. 上游失败时**返回原因**而不是抛异常（界面要把原因显示出来）；
//   4. `prevRemain` 是「上一次真实读取」的值，用来算「较上次 ±X」。
//
// 用一个假通道做上游：`creditsOf` 每次返回递增的数，顺便数一下被调了几次。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-credits-'));
process.env.QB_DATA_DIR = tempData;

const { channels } = await import('../src/channels/index.ts');
const accounts = await import('../src/core/accounts.ts');
const { creditsByAccount, refreshCredits } = await import('../src/core/credits.ts');

const checks = [];
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  checks.push({ name, ok, got, want });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`}`);
}

/* ------------------------------ 假通道 ------------------------------ */

let upstreamCalls = 0;
let nextRemain = 100;
const fake = {
  id: 'creditsprobe',
  idPrefix: 'cp',
  label: 'CreditsProbe',
  identity: { clientVersion: '1.0.0' },
  modelsOf: async () => [],
  creditsOf: async () => {
    upstreamCalls += 1;
    return { provider: 'creditsprobe', supported: true, totalRemain: nextRemain, packages: [{ used: 5, limit: 50 }] };
  },
};
channels.push(fake);

const broken = {
  id: 'creditsbroken',
  idPrefix: 'cb',
  label: 'CreditsBroken',
  identity: { clientVersion: '1.0.0' },
  modelsOf: async () => [],
  creditsOf: async () => {
    throw new Error('凭据已过期');
  },
};
channels.push(broken);

const account = accounts.addAccount({ channelId: 'creditsprobe', idPrefix: 'cp', credential: { token: 'a' } });
const brokenAccount = accounts.addAccount({ channelId: 'creditsbroken', idPrefix: 'cb', credential: { token: 'b' } });

/* ------------------------------ 1. 手动刷新绕过缓存 ------------------------------ */

console.log('\n--- 1. 手动刷新绕 30 秒缓存 ---');
const first = await refreshCredits([account]);
check('第一次读到 100', first[account.id].snapshot.remain, 100);
check('确实打了一次上游', upstreamCalls, 1);

nextRemain = 88;
const second = await refreshCredits([account]);
check('第二次读到 88（没有被缓存挡住）', second[account.id].snapshot.remain, 88);
check('又打了一次上游', upstreamCalls, 2);

/* ------------------------------ 2. 列表读取仍然走缓存 ------------------------------ */

console.log('\n--- 2. 列表读取用缓存（刷新不能变成"每次都打上游"）---');
const listOnce = await creditsByAccount([account]);
check('列表读到最新值 88', listOnce[account.id].remain, 88);
check('列表读的是缓存，没有新增上游调用', upstreamCalls, 2);

/* ------------------------------ 3. prevRemain 语义 ------------------------------ */

console.log('\n--- 3. prevRemain 是上一次真实读取的值 ---');
check('prevRemain = 100（上上次读到的）', second[account.id].snapshot.prevRemain, 100);
check('prevAt 有值', typeof second[account.id].snapshot.prevAt, 'number');
// 两次读取可能落在同一毫秒里（`Date.now()` 精度就这么粗），所以是「不早于」而不是「晚于」。
check('at 不早于 prevAt', second[account.id].snapshot.at >= second[account.id].snapshot.prevAt, true);

/* ------------------------------ 4. 上游失败要说原因 ------------------------------ */

console.log('\n--- 4. 上游失败：返回原因，不抛异常 ---');
const failed = await refreshCredits([brokenAccount]);
check('remain 是 null（界面显示 —）', failed[brokenAccount.id].snapshot.remain, null);
check('error 是上游原文', failed[brokenAccount.id].error, '凭据已过期');

// 通道查不到时也不能抛
const ghost = { ...account, id: 'ghost-1', channelId: 'nope' };
const ghostReads = await refreshCredits([ghost]);
check('通道不存在时如实报错', ghostReads['ghost-1'].error, '没有通道 nope');

/* ------------------------------ 5. 批量（通道级）------------------------------- */

console.log('\n--- 5. 一次刷多个账号 ---');
nextRemain = 42;
const many = await refreshCredits([account, brokenAccount]);
check('好的那个拿到 42', many[account.id].snapshot.remain, 42);
check('坏的那个照样报错', many[brokenAccount.id].error, '凭据已过期');

/* ------------------------------ 收尾 ------------------------------ */

const { closeDb } = await import('../src/shared/db.ts');
closeDb();
fs.rmSync(tempData, { recursive: true, force: true });

const failedCount = checks.filter((c) => !c.ok).length;
if (failedCount === 0) console.log(`\n全部通过（${checks.length} 项）`);
else console.log(`\n${failedCount}/${checks.length} 项失败`);
process.exitCode = failedCount === 0 ? 0 : 1;
