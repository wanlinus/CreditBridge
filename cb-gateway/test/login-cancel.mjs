import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-login-cancel-'));
process.env.QB_DATA_DIR = tempData;

const accounts = await import('../src/core/accounts.ts');
const { cancelLogin, cancelRunningLogins, getLoginTask, publicTask, startLogin } = await import(
  '../src/core/login-tasks.ts'
);
accounts.loadAccounts();

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeChannel(id, idPrefix) {
  let release;
  let opened;
  const gate = new Promise((r) => { release = r; });
  const channel = {
    id,
    idPrefix,
    label: id,
    identity: { clientVersion: 'test' },
    async modelsOf() { return []; },
    async creditsOf() { throw new Error('n/a'); },
    async chatAs() { throw new Error('n/a'); },
    login(options) {
      options.onUrl?.(`https://example.test/login?state=${id}`);
      return new Promise((resolve, reject) => {
        opened = () => resolve({
          credential: { accessToken: 'tok', uid: `uid-${id}` },
          profile: { uid: `uid-${id}`, username: `${id} 号` },
          label: `${id} 号`,
        });
        options.signal?.addEventListener('abort', () => reject(new Error('登录已取消')), { once: true });
      });
    },
  };
  return { channel, release: () => (opened ? opened() : undefined), gate };
}

console.log('--- 1. 起任务、拿到 url ---');
const a = makeChannel('fakea', 'fa');
const started = startLogin(a.channel);
check('起得来', started.ok === true);
const taskA = started.task;
check('state 是 running', taskA.state, 'running');
check('url 已填上', taskA.url, 'https://example.test/login?state=fakea');
check('publicTask 不含 controller', 'controller' in publicTask(taskA), false);

console.log('--- 2. 取消 ---');
check('cancelLogin 返回 true', cancelLogin('fakea', taskA.taskId), true);
check('state 变 cancelled', getLoginTask('fakea', taskA.taskId).state, 'cancelled');
check('message 是「已取消」', getLoginTask('fakea', taskA.taskId).message, '已取消');
check('已有 finishedAt', typeof getLoginTask('fakea', taskA.taskId).finishedAt, 'number');

console.log('--- 3. 迟到的授权结果不能落成账号 ---');
const before = accounts.accountsOf('fakea').length;
a.release();
await sleep(30);
check('账号数量没变', accounts.accountsOf('fakea').length, before);
check('state 仍是 cancelled（没被改回 done）', getLoginTask('fakea', taskA.taskId).state, 'cancelled');

console.log('--- 4. 重复取消是幂等的 ---');
check('再取消返回 false', cancelLogin('fakea', taskA.taskId), false);
check('state 还是 cancelled', getLoginTask('fakea', taskA.taskId).state, 'cancelled');

console.log('--- 5. 再点一次登录 = 取代旧的，不是排队 ---');
const b = makeChannel('fakeb', 'fb');
const first = startLogin(b.channel);
const second = startLogin(b.channel);
check('第二次也起来了', second.ok === true);
check('第一次被标成 cancelled', getLoginTask('fakeb', first.task.taskId).state, 'cancelled');
check('第一次的 message 说明被取代', getLoginTask('fakeb', first.task.taskId).message, '已被新的登录取代');
check('第二次在跑', getLoginTask('fakeb', second.task.taskId).state, 'running');
check('两个 taskId 不同', first.task.taskId !== second.task.taskId);

console.log('--- 6. 正常完成仍然能落成账号 ---');
const c = makeChannel('fakec', 'fc');
const ok = startLogin(c.channel);
c.release();
await sleep(30);
check('state 是 done', getLoginTask('fakec', ok.task.taskId).state, 'done');
check('拿到了 accountId', typeof getLoginTask('fakec', ok.task.taskId).accountId, 'string');
check('账号真的建出来了', accounts.accountsOf('fakec').length, 1);

console.log('--- 7. cancelRunningLogins 只影响指定通道 ---');
const d1 = makeChannel('faked', 'fd');
const d2 = makeChannel('fakee', 'fe');
const taskD = startLogin(d1.channel);
const taskE = startLogin(d2.channel);
check('取消 d 通道返回 1', cancelRunningLogins('faked'), 1);
check('d 被取消', getLoginTask('faked', taskD.task.taskId).state, 'cancelled');
check('e 还在跑', getLoginTask('fakee', taskE.task.taskId).state, 'running');
taskE.task.controller?.abort();

console.log('--- 8. 不存在的任务 ---');
check('cancelLogin 未知任务返回 false', cancelLogin('nope', '123'), false);
check('getLoginTask 未知任务返回 undefined', getLoginTask('nope', '123') === undefined);

fs.rmSync(tempData, { recursive: true, force: true });
console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
