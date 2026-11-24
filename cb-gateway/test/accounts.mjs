// 账号层：存储、序号分配、状态机、凭据刷新。全部跑在临时目录里。
//
// 跑：node test/accounts.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-accounts-'));
process.env.QB_DATA_DIR = tempData;

const accounts = await import('../src/core/accounts.ts');
// v4 起账号进库（`account` / `account_seq`），断言查库而不是查文件。
const { db, closeDb } = await import('../src/shared/db.ts');

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

const dbRow = (id) => db.prepare('SELECT * FROM account WHERE id = ?').get(id);
const cursor = (channelId) => db.prepare('SELECT seq FROM account_seq WHERE channel_id = ?').get(channelId)?.seq;

// ---- 1. 空目录 ----
check('全新部署零账号', accounts.loadAccounts(), []);
check('按通道查也是空', accounts.accountsOf('workbuddy'), []);

// ---- 2. 加账号 ----
const wb1 = accounts.addAccount({ channelId: 'workbuddy', idPrefix: 'wb', credential: { accessToken: 'a' }, label: '示例账号' });
check('第一个号是 1 号', wb1.id, 'wb-1');
check('label 用传进来的', wb1.label, '示例账号');
check('默认状态 ready', wb1.status, 'ready');
check('落库了', JSON.parse(dbRow('wb-1').credential).accessToken, 'a');
check('库里凭据是 JSON 文本，不是拆开的列', typeof dbRow('wb-1').credential, 'string');

const wb2 = accounts.addAccount({ channelId: 'workbuddy', idPrefix: 'wb', credential: { accessToken: 'b' } });
check('没给 label 时用「账号N」', [wb2.id, wb2.label], ['wb-2', '账号2']);
check('账号按序号排序', accounts.accountsOf('workbuddy').map((a) => a.id), ['wb-1', 'wb-2']);

const tr1 = accounts.addAccount({ channelId: 'trae', idPrefix: 'tr', credential: {} });
check('不同通道各排各的序号', tr1.id, 'tr-1');

// ---- 3. 序号只增不减 ----
check('删掉 2 号', accounts.removeAccount('wb-2'), true);
check('删号后列表少一个', accounts.accountsOf('workbuddy').map((a) => a.id), ['wb-1']);
check('新号拿 3 而不是 2（账本里的 wb-2 不能被新号接手）', accounts.addAccount({ channelId: 'workbuddy', idPrefix: 'wb', credential: {} }).id, 'wb-3');
check('删不存在的号返回 false', accounts.removeAccount('wb-99'), false);

// 重启（重新加载）之后序号游标还在：不能因为重启就把序号用回去。
accounts.loadAccounts();
check('重启后账号还在', accounts.accountsOf('workbuddy').map((a) => a.id), ['wb-1', 'wb-3']);
check('重启后序号继续往后走', accounts.addAccount({ channelId: 'workbuddy', idPrefix: 'wb', credential: {} }).id, 'wb-4');
check('游标和现存最大 seq 一致', [cursor('workbuddy'), Math.max(...accounts.accountsOf('workbuddy').map((a) => a.seq))], [4, 4]);

// ---- 4. 按上游 uid 去重 ----
accounts.updateAccount('wb-1', { profile: { uid: 'u-1', username: '示例账号' } });
check('同 uid 能找回来', accounts.findAccountByUid('workbuddy', 'u-1')?.id, 'wb-1');
check('uid 为空时不误匹配', accounts.findAccountByUid('workbuddy', '') === undefined);
check('跨通道不串', accounts.findAccountByUid('trae', 'u-1') === undefined);

// ---- 5. 改 label / 凭据 ----
check('改 label', accounts.updateAccount('wb-1', { label: '新名字' }).label, '新名字');
check('空 label 不生效（避免把名字改没）', accounts.updateAccount('wb-1', { label: '' }).label, '新名字');
check('改凭据', accounts.updateAccount('wb-1', { credential: { accessToken: 'z' } }).credential.accessToken, 'z');

// ---- 6. 状态机 ----
check('标 invalid', accounts.markInvalid('wb-1', '刷新失败').status, 'invalid');
check('invalid 的提示让去重新登录', accounts.checkUsable(accounts.getAccount('wb-1')).code, 'account_invalid');
check('invalid 的提示带账号 id', accounts.checkUsable(accounts.getAccount('wb-1')).message.includes('wb-1'), true);
check('重新登录后回 ready', accounts.markReady('wb-1').status, 'ready');
check('ready 可以用', accounts.checkUsable(accounts.getAccount('wb-1')).ok, true);

accounts.markCooldown('wb-1', Date.now() + 60_000, '上游限流');
check('冷却中不能用', accounts.checkUsable(accounts.getAccount('wb-1')).code, 'account_cooldown');
check('冷却提示里有截止时间', /限流中，\d\d:\d\d 后可再用/u.test(accounts.checkUsable(accounts.getAccount('wb-1')).message), true);
check('冷却不影响别的号', accounts.checkUsable(accounts.getAccount('wb-3')).ok, true);

// 冷却到点自动回 ready（不然一次限流就永久锁死账号）。
accounts.markCooldown('wb-1', Date.now() - 1);
check('冷却到点后立刻可用', accounts.checkUsable(accounts.getAccount('wb-1')).ok, true);
check('并且状态已写回 ready', accounts.getAccount('wb-1').status, 'ready');

check('停用', accounts.setStatus('wb-1', 'disabled').status, 'disabled');
check('停用的提示是「已停用」', accounts.checkUsable(accounts.getAccount('wb-1')).code, 'account_disabled');

// ---- 7. 按上游状态码改状态 ----
accounts.markReady('wb-1');
check('401 → invalid', accounts.applyFailure(accounts.getAccount('wb-1'), 401, 'unauthorized').status, 'invalid');
accounts.markReady('wb-1');
check('429 → cooldown', accounts.applyFailure(accounts.getAccount('wb-1'), 429, 'too many').status, 'cooldown');
accounts.markReady('wb-1');
check('500 不改状态（上游炸了，不是这个号的问题）', accounts.applyFailure(accounts.getAccount('wb-1'), 500, 'boom') === undefined);
check('500 之后仍是 ready', accounts.getAccount('wb-1').status, 'ready');

// ---- 8. 凭据刷新 ----
let refreshes = 0;
const expired = { accessToken: 'old', expiresAt: Date.now() - 1000 };
accounts.updateAccount('wb-1', { credential: expired });
const fresh = await accounts.usableCredential(accounts.getAccount('wb-1'), async (credential) => {
  refreshes += 1;
  return { ...credential, accessToken: 'new', expiresAt: Date.now() + 3600_000 };
});
check('过期的凭据会刷', fresh.accessToken, 'new');
check('刷新只跑一次', refreshes, 1);
check('刷新结果写回了账号', accounts.getAccount('wb-1').credential.accessToken, 'new');

const still = await accounts.usableCredential(accounts.getAccount('wb-1'), async () => {
  throw new Error('不该刷新');
});
check('没过期就不刷', still.accessToken, 'new');

// 并发：多个请求同时撞上过期，只该换一次 token。
accounts.updateAccount('wb-2' in {} ? 'wb-2' : 'wb-3', { credential: { accessToken: 'old', expiresAt: Date.now() - 1000 } });
let concurrent = 0;
const target = accounts.getAccount('wb-3');
const results = await Promise.all([
  accounts.usableCredential(target, async (c) => {
    concurrent += 1;
    await new Promise((r) => setTimeout(r, 30));
    return { ...c, accessToken: 'new', expiresAt: Date.now() + 3600_000 };
  }),
  accounts.usableCredential(target, async (c) => {
    concurrent += 1;
    return { ...c, accessToken: 'other', expiresAt: Date.now() + 3600_000 };
  }),
]);
check('并发只刷新一次', concurrent, 1);
check('两个调用拿到同一份新凭据', results[0].accessToken === results[1].accessToken, true);

// ISO 字符串形式的 expiresAt（Qoder 的存法）也要认。
accounts.updateAccount('wb-3', { credential: { token: 'dt-x', expiresAt: new Date(Date.now() + 3600_000).toISOString() } });
check(
  'ISO 形式的有效期不触发刷新',
  (await accounts.usableCredential(accounts.getAccount('wb-3'), async () => {
    throw new Error('不该刷新');
  })).token,
  'dt-x',
);

check('没有凭据时报错（不是静默返回空）', await (async () => {
  accounts.updateAccount('wb-3', { credential: null });
  try {
    await accounts.usableCredential(accounts.getAccount('wb-3'), async () => ({}));
    return 'no-error';
  } catch (error) {
    return error.message.includes('wb-3') ? 'error-with-id' : 'error-without-id';
  }
})(), 'error-with-id');

// 先关库再删临时目录：Windows 上删不掉一个被打开的文件（EPERM）。
closeDb();
fs.rmSync(tempData, { recursive: true, force: true });
console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
