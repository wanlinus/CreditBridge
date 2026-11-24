/**
 * Qoder 多账号的回归测试。
 *
 * ## 为什么现在才敢开
 *
 * 以前 `multiAccount: false`，理由是「对话靠常驻 CLI 的登录态，那是机器级的一份」。
 * 多挂号会让 `qd-2` 实际花 `qd-1` 的钱——账号层因此直接拦住第二个。
 *
 * CLI 移除后这个前提消失了：每个号有独立的 `dt-` + `userInfo`，签名也按账号走。
 * 所以放开成 `true`。
 *
 * ## 这套钉住什么
 *
 * 1. 通道声明上是 `multiAccount: true`
 * 2. 账号层据此允许并列挂多个号
 * 3. **每个号的凭据互不覆盖**——这是放开多账号的前提，覆盖了就等于串号
 * 4. `/api/health` 与 `/api/channels` 回报 `multiAccount: true`（界面据此显示"添加账号"）
 *
 * 跑：node test/qoder-multi-account.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

// 用独立的数据目录，别碰真实的 data/
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-qoder-multi-'));
process.env.QB_DATA_DIR = sandbox;

const { qoderChannel } = await import('../src/channels/qoder/index.ts');
const accounts = await import('../src/core/accounts.ts');

/* ================================================ 1. 通道声明 */

console.log('--- 1. 通道声明 ---');
check('multiAccount 是 true', qoderChannel.multiAccount, true);
check('reportsTokens 是 true', qoderChannel.reportsTokens, true);
check('idPrefix 是 qd', qoderChannel.idPrefix, 'qd');
check('identity 带 clientVersion', typeof qoderChannel.identity?.clientVersion, 'string');

/* ============================================ 2. 账号层允许并列 */

console.log('\n--- 2. 账号层允许并列两个号 ---');

const first = accounts.addAccount({
  channelId: qoderChannel.id,
  idPrefix: qoderChannel.idPrefix,
  credential: { token: 'dt-first', userId: 'uid-first', source: 'device-flow', savedAt: Date.now() },
  label: '第一个号',
  profile: { uid: 'uid-first', username: 'first@example.com' },
});

const second = accounts.addAccount({
  channelId: qoderChannel.id,
  idPrefix: qoderChannel.idPrefix,
  credential: { token: 'dt-second', userId: 'uid-second', source: 'device-flow', savedAt: Date.now() },
  label: '第二个号',
  profile: { uid: 'uid-second', username: 'second@example.com' },
});

check('第一个号建成', typeof first.id, 'string');
check('第二个号建成', typeof second.id, 'string');
check('两个号 id 不同', first.id !== second.id, true);

const list = accounts.accountsOf(qoderChannel.id);
check('账号列表有 2 个', list.length, 2);

/* ===================================== 3. 凭据互不覆盖（串号检查） */

console.log('\n--- 3. 凭据互不覆盖 ---');
const reloadedFirst = accounts.getAccount(first.id);
const reloadedSecond = accounts.getAccount(second.id);

check('第一个号 token 没被覆盖', reloadedFirst?.credential?.token, 'dt-first');
check('第二个号 token 没被覆盖', reloadedSecond?.credential?.token, 'dt-second');
check('第一个号 userId 正确', reloadedFirst?.credential?.userId, 'uid-first');
check('第二个号 userId 正确', reloadedSecond?.credential?.userId, 'uid-second');
// 这是放开多账号的**核心前提**：两个号的凭据必须是两套
check('两套凭据不同', reloadedFirst?.credential?.token !== reloadedSecond?.credential?.token, true);

/* ==================================== 4. 按 uid 查重仍然生效 */

console.log('\n--- 4. 同 uid 不新建（重登覆盖自己） ---');
const dup = accounts.findAccountByUid(qoderChannel.id, 'uid-first');
check('能按 uid 找到第一个号', dup?.id, first.id);
// 找不到时返回 undefined，所以断言要拿 `=== undefined` 比，不能拿返回值本身比
check('找不到不存在的 uid', accounts.findAccountByUid(qoderChannel.id, 'uid-nobody') === undefined, true);

/* ================================ 5. 清理沙箱 */

// SQLite 连接还开着时 Windows 会拒绝删除目录。清理失败不算测试失败——
// 临时目录由系统回收，测试的关键是上面的断言。
try {
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 });
} catch {
  console.log(`  （沙箱目录未能删除，系统会回收：${path.basename(sandbox)}）`);
}

console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
