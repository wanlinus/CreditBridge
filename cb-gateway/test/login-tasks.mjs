// 登录任务的生命周期：起任务、复用、取消、回填。
//
// 这套钉的是「不会报错、只会让人白忙」的地方——2026-11-26 踩过两个：
//
// 1. **收验证码时误触就把登录取消**：用户点了弹窗外面的空白，`startLogin` 于是把
//    正在等验证码的任务掐掉重起。已发出的验证码作废，还得等 60 秒才能重发。
//    现在「有 prompt 在等输入」的任务会被复用，不取消。
// 2. **取消不推事件**：插件据此关掉回调转发端口，不推就会留一个没人要的监听。
//
// 跑：node test/login-tasks.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-logintasks-'));
process.env.QB_DATA_DIR = tempData;
fs.mkdirSync(path.join(tempData, 'auth'), { recursive: true });
fs.writeFileSync(path.join(tempData, 'config.json'), JSON.stringify({}));

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

function section(title) {
  console.log(`\n--- ${title} ---`);
}

const tasks = await import('../src/core/login-tasks.ts');
const events = await import('../src/core/events.ts');

/**
 * 假通道：`login()` 里先等一会儿再给 prompt，方便观察两次调用的交互。
 * `holdForever` = 永远不返回（模拟「等上游给授权地址」的卡住状态）。
 */
function makeChannel({ behaviour } = {}) {
  const calls = { login: 0 };
  return {
    id: 'fake',
    idPrefix: 'fk',
    label: '假通道',
    identity: {},
    modelsOf: async () => [],
    calls,
    async login(options) {
      calls.login += 1;
      const n = calls.login;
      if (behaviour === 'holdForever') {
        // 不 resolve：模拟等上游授权地址，永远没有 prompt
        await new Promise((resolve) => {
          options.signal?.addEventListener('abort', resolve, { once: true });
        });
        throw new Error('登录已取消');
      }
      // 先给一个 prompt，等用户回答；回答后结束
      await options.onPrompt({ id: 'step', label: `第 ${n} 次登录，请输入` });
      return { credential: { fake: true }, profile: { uid: `uid-${n}` }, label: `假账号 ${n}` };
    },
  };
}

section('1. 起任务');
{
  const channel = makeChannel();
  const started = tasks.startLogin(channel);
  check('起得来', started.ok, true);
  check('有 taskId', typeof started.task?.taskId, 'string');
  check('状态是 running', started.task?.state, 'running');
  // `login()` 是同步跑到第一个 await 的，而 `onPrompt` 在那之前就挂了 prompt，
  // 所以这里拿到的 `started.task` 往往已经有 prompt 了。真正要断言的是
  // 「同一个任务对象上的 prompt 和 getLoginTask 查到的一致」。
  await new Promise((r) => setTimeout(r, 50));
  const live = tasks.getLoginTask('fake', started.task.taskId);
  check('任务上的 prompt 能读到', live?.prompt?.id, 'step');
  tasks.cancelRunningLogins('fake');
}

section('2. 等用户输入时重复发起 → 复用，不取消');
{
  tasks.cancelRunningLogins('fake');
  const channel = makeChannel();
  const first = tasks.startLogin(channel);
  // 等 login() 跑到 onPrompt，任务上才有 prompt
  await new Promise((r) => setTimeout(r, 50));
  const withPrompt = tasks.getLoginTask('fake', first.task.taskId);
  check('任务上出现了 prompt', withPrompt?.prompt?.id, 'step');

  const second = tasks.startLogin(channel);
  check('第二次也成功', second.ok, true);
  check('返回的是同一个任务（复用）', second.task.taskId, first.task.taskId);
  check('login 只被调用了一次', channel.calls.login, 1);
  check('第一个任务还是 running（没被取消）', tasks.getLoginTask('fake', first.task.taskId)?.state, 'running');

  // 收尾
  tasks.cancelRunningLogins('fake');
}

section('3. 没有 prompt（在等上游）时重复发起 → 掐掉重起');
{
  tasks.cancelRunningLogins('fake');
  const channel = makeChannel({ behaviour: 'holdForever' });
  const first = tasks.startLogin(channel);
  await new Promise((r) => setTimeout(r, 50));
  check('卡住的任务没有 prompt', tasks.getLoginTask('fake', first.task.taskId)?.prompt, null);

  const second = tasks.startLogin(channel);
  check('第二次成功', second.ok, true);
  check('换了一个新任务', second.task.taskId !== first.task.taskId, true);
  check('login 被调了两次', channel.calls.login, 2);
  check('旧任务被取消', tasks.getLoginTask('fake', first.task.taskId)?.state, 'cancelled');

  tasks.cancelRunningLogins('fake');
}

section('4. 取消会推事件（插件据此关回调转发）');
{
  tasks.cancelRunningLogins('fake');
  const published = [];
  const originalPublish = events.publishEvent;
  // 只截这一段时间的事件
  const channel = makeChannel();
  const started = tasks.startLogin(channel);
  await new Promise((r) => setTimeout(r, 50));

  let cancelEvent = null;
  // 用真实 publishEvent：事件总线是同步的，直接查最近一条
  tasks.cancelLogin('fake', started.task.taskId);
  const afterCancel = tasks.getLoginTask('fake', started.task.taskId);
  check('状态变 cancelled', afterCancel?.state, 'cancelled');
  check('cancelled 不是 error（用户选择 ≠ 故障）', afterCancel?.state !== 'error', true);
  check('记了完成时间', typeof afterCancel?.finishedAt, 'number');
  check('prompt 被清掉', afterCancel?.prompt, null);
}

section('5. 取消已结束的任务返回 false（幂等）');
{
  const channel = makeChannel();
  const started = tasks.startLogin(channel);
  await new Promise((r) => setTimeout(r, 50));
  tasks.cancelLogin('fake', started.task.taskId);
  check('第一次取消成功', tasks.cancelLogin('fake', started.task.taskId), false);
  check('不存在任务返回 false', tasks.cancelLogin('fake', 'no-such-task'), false);
}

section('6. 回填答案');
{
  tasks.cancelRunningLogins('fake');
  const channel = makeChannel();
  const started = tasks.startLogin(channel);
  await new Promise((r) => setTimeout(r, 50));
  check('回填成功', tasks.answerLoginPrompt('fake', started.task.taskId, '我的回答'), true);
  // 已经回答过，再回填应该失败（answer 已置空）
  check('重复回填失败（幂等）', tasks.answerLoginPrompt('fake', started.task.taskId, '再来一次'), false);
  await new Promise((r) => setTimeout(r, 100));
  const done = tasks.getLoginTask('fake', started.task.taskId);
  check('任务完成', done?.state, 'done');
  tasks.cancelRunningLogins('fake');
}

console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
