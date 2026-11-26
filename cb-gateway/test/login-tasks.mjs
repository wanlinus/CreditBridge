// 守护登录任务：等输入时复用不取消、等上游时掐掉重起、取消要推事件、回填幂等。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, section, done } from './_helpers.mjs';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-logintasks-'));
process.env.QB_DATA_DIR = tempData;
fs.mkdirSync(path.join(tempData, 'auth'), { recursive: true });
fs.writeFileSync(path.join(tempData, 'config.json'), JSON.stringify({}));

const tasks = await import('../src/core/login-tasks.ts');
const events = await import('../src/core/events.ts');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 假通道：login() 先等一会儿再给 prompt；holdForever 模拟「等上游授权地址」的卡住状态。
function makeChannel({ holdForever } = {}) {
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
      if (holdForever) {
        await new Promise((resolve) => options.signal?.addEventListener('abort', resolve, { once: true }));
        throw new Error('登录已取消');
      }
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
  await sleep(50);
  check('任务上的 prompt 能读到', tasks.getLoginTask('fake', started.task.taskId)?.prompt?.id, 'step');
  tasks.cancelRunningLogins('fake');
}

section('2. 等输入时重复发起 → 复用，不取消');
{
  tasks.cancelRunningLogins('fake');
  const channel = makeChannel();
  const first = tasks.startLogin(channel);
  await sleep(50);
  check('任务上出现了 prompt', tasks.getLoginTask('fake', first.task.taskId)?.prompt?.id, 'step');

  const second = tasks.startLogin(channel);
  check('第二次也成功', second.ok, true);
  check('返回的是同一个任务（复用）', second.task.taskId, first.task.taskId);
  check('login 只被调用了一次', channel.calls.login, 1);
  check('第一个任务还是 running（没被取消）', tasks.getLoginTask('fake', first.task.taskId)?.state, 'running');
  tasks.cancelRunningLogins('fake');
}

section('3. 没有 prompt（在等上游）时重复发起 → 掐掉重起');
{
  tasks.cancelRunningLogins('fake');
  const channel = makeChannel({ holdForever: true });
  const first = tasks.startLogin(channel);
  await sleep(50);
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
  const seen = [];
  const unsubscribe = events.subscribeEvents((e) => seen.push(e));
  const channel = makeChannel();
  const started = tasks.startLogin(channel);
  await sleep(50);

  tasks.cancelLogin('fake', started.task.taskId);
  const afterCancel = tasks.getLoginTask('fake', started.task.taskId);
  check('状态变 cancelled', afterCancel?.state, 'cancelled');
  check('cancelled 不是 error（用户选择 ≠ 故障）', afterCancel?.state !== 'error', true);
  check('记了完成时间', typeof afterCancel?.finishedAt, 'number');
  check('prompt 被清掉', afterCancel?.prompt, null);
  // 事件总线是同步的：取消动作里必然推一条 state=cancelled 的 login 事件，否则插件不会关转发
  check('推了 cancelled 事件', seen.some((e) => e.type === 'login' && e.state === 'cancelled' && e.taskId === started.task.taskId));
  unsubscribe();
}

section('5. 取消已结束的任务返回 false（幂等）');
{
  const channel = makeChannel();
  const started = tasks.startLogin(channel);
  await sleep(50);
  tasks.cancelLogin('fake', started.task.taskId);
  check('第二次取消返回 false', tasks.cancelLogin('fake', started.task.taskId), false);
  check('不存在任务返回 false', tasks.cancelLogin('fake', 'no-such-task'), false);
}

section('6. 回填答案');
{
  tasks.cancelRunningLogins('fake');
  const channel = makeChannel();
  const started = tasks.startLogin(channel);
  await sleep(50);
  check('回填成功', tasks.answerLoginPrompt('fake', started.task.taskId, '我的回答'), true);
  check('重复回填失败（幂等）', tasks.answerLoginPrompt('fake', started.task.taskId, '再来一次'), false);
  await sleep(100);
  check('任务完成', tasks.getLoginTask('fake', started.task.taskId)?.state, 'done');
  tasks.cancelRunningLogins('fake');
}

done();
