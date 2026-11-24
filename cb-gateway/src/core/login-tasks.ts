// 一次登录任务的进度。前端轮询 `GET /api/accounts/<channel>/login/<taskId>` 读它。
//
// 登录是交互式且可能阻塞几分钟的（等用户在浏览器里操作），所以起点是「起一个
// 后台任务、立刻返回句柄」，不是在一个请求里同步等。
//
// **任务只负责拿到凭据并落成账号**：存成第几号、要不要复用已有的号（同一个上游
// 账号登两次不该产生两个文件），都在这里定——它就是「登录 → 账号」的接缝。

import type { Account, Channel, LoginPrompt } from '../types.ts';
import { log } from '../logger.ts';
import { accountsOf, addAccount, findAccountByUid, getAccount, markReady, updateAccount } from './accounts.ts';
import { publishEvent } from './events.ts';

export interface LoginTask {
  taskId: string;
  channelId: string;
  /**
   * `cancelled` 是**用户主动放弃**，和 `error`（失败）分开：
   * 页面要显示不同的话术，而且取消之后迟到的授权结果必须作废。
   */
  state: 'running' | 'done' | 'error' | 'cancelled';
  url: string | null;
  /** 表单式登录（Loomy 短信验证码）当前要用户填的一步；URL 式登录恒为 null。 */
  prompt: LoginPrompt | null;
  message: string | null;
  startedAt: number;
  finishedAt: number | null;
  /**
   * 这次登录的回调要不要「浏览器那台机器」把 127.0.0.1:<port> 转进来。
   *
   * 在起任务时算一次并存下来（`channel.loginLoopback()`），之后所有事件都用这一个
   * 值：端口在一次登录的生命周期里不会变，每次重算只会让取消事件里拿不到通道对象
   * 时还要去翻注册表。
   */
  loopback: { port: number; path: string } | null;
  /** 成功后落到哪个账号（新号或复用的旧号）。 */
  accountId?: string;
  /** 用来掐掉上一次：用户再点一次「登录」就是重来一遍，不该干等 5 分钟。 */
  controller?: AbortController;
  /** 表单式登录：当前 prompt 的应答器（用户提交后 resolve，取消后 reject）。 */
  answer?: (value: string) => void;
}

/** 键是 `<channelId>:<taskId>`，同一个通道可以先后跑不同任务。 */
const loginTasks = new Map<string, LoginTask>();

/** taskId 里的自增段：保证同一毫秒内的两次登录不会撞号（见 `startLogin`）。 */
let loginTaskSeq = 0;

function taskKey(channelId: string, taskId: string) {
  return `${channelId}:${taskId}`;
}

export function getLoginTask(channelId: string, taskId: string): LoginTask | undefined {
  return loginTasks.get(taskKey(channelId, taskId));
}

/** 给前端的任务视图。`controller` / `answer` 不能序列化，也不该出现在响应里。 */
export function publicTask(task: LoginTask) {
  return {
    taskId: task.taskId,
    channelId: task.channelId,
    state: task.state,
    url: task.url,
    prompt: task.prompt,
    message: task.message,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    accountId: task.accountId ?? null,
  };
}

/**
 * 把任务状态推给订阅者（插件）。
 *
 * 只推给在线订阅者，不做队列重放：插件断线期间的事件就该丢——它没连着的时候用户
 * 也开不了登录通道，补发一条过期的「登录中」只会让插件去开一个已经没有意义的端口。
 */
function emitLogin(task: LoginTask): void {
  publishEvent({
    type: 'login',
    channelId: task.channelId,
    taskId: task.taskId,
    state: task.state,
    loopback: task.loopback,
    message: task.message,
  });
}

/**
 * 登录成功后把凭据变成一条账号记录。
 *
 * 三种情况，按优先级：
 *   1. 上游 uid 已经存在 → 复用那个号（更新凭据、状态回 ready）
 *   2. 通道只支持一个账号（Qoder）→ 覆盖它唯一那个号
 *   3. 其余 → 新建，序号由账号层分配（只增不减）
 */
export function materializeAccount(channel: Channel, result: any): Account | undefined {
  const uid = typeof result?.profile?.uid === 'string' ? result.profile.uid : '';
  const profile = { ...(result?.profile || {}) };
  const credential = result?.credential;

  const existing = uid ? findAccountByUid(channel.id, uid) : undefined;
  if (existing) {
    updateAccount(existing.id, { credential, profile: { ...existing.profile, ...profile } });
    markReady(existing.id);
    log(`${channel.id} 登录到已有账号 ${existing.id}（uid 相同，不新建）`);
    return getAccount(existing.id);
  }

  if (channel.multiAccount === false) {
    const first = accountsOf(channel.id)[0];
    if (first) {
      updateAccount(first.id, { credential, profile: { ...first.profile, ...profile } });
      markReady(first.id);
      log(`${channel.id} 只支持一个账号，覆盖 ${first.id} 的凭据`);
      return getAccount(first.id);
    }
  }

  const created = addAccount({
    channelId: channel.id,
    idPrefix: channel.idPrefix,
    credential,
    label: typeof result?.label === 'string' ? result.label : undefined,
    profile,
  });
  log(`${channel.id} 新账号 ${created.id} label=${created.label}`);
  return created;
}

/**
 * 启动一次登录。
 *
 * 同一通道已有任务在跑时不复用，而是掐掉旧的再起新的：页面上那个「登录中…」卡住
 * 时，用户能做的唯一一件事就是再点一次，复用会让这次点击变成无操作。
 */
export function startLogin(channel: Channel): { ok: boolean; task?: LoginTask; error?: string } {
  if (typeof channel.login !== 'function') return { ok: false, error: `${channel.label} 不支持自助登录` };
  // 单账号通道已经有号时，登录的含义是「重新登录这个号」，仍然允许。
  // 同通道上一次还在跑就先取消掉：再点一次是「重来」，不是「排队」。
  const cancelled = cancelRunningLogins(channel.id);
  if (cancelled > 0) log(`${channel.id} 重新发起登录，取消了 ${cancelled} 个未完成任务`);

  const controller = new AbortController();
  // **不能只用 `Date.now()`**：同一毫秒里连点两次（或测试连续调两次）会撞同一个
  // taskId，两个任务共用一条 Map 键，第二次把第一次覆盖掉——表现是「点两次登录，
  // 只有一个任务，而且前一个永远 running」。
  const taskId = `${Date.now()}-${(loginTaskSeq += 1)}`;
  const task: LoginTask = {
    taskId,
    channelId: channel.id,
    state: 'running',
    url: null,
    prompt: null,
    message: null,
    startedAt: Date.now(),
    finishedAt: null,
    // 只在起任务时算一次，见 `LoginTask.loopback` 的说明。
    loopback: typeof channel.loginLoopback === 'function' ? channel.loginLoopback() : null,
    controller,
  };
  loginTasks.set(taskKey(channel.id, taskId), task);
  // 只留最近 20 个任务：这是内存里的临时状态，没人在意一小时前那次登录的进度。
  if (loginTasks.size > 20) {
    const oldest = [...loginTasks.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt)[0];
    if (oldest) loginTasks.delete(oldest[0]);
  }
  // **先推再起 login()**：插件要在这个端口上开好转发，用户的浏览器才可能跳回来。
  // 晚推一步的结果是「授权完成但没人接」，用户看到的就是登录失败。
  emitLogin(task);

  channel
    .login({
      onUrl: (url: string) => {
        task.url = url;
      },
      onPrompt: (prompt: LoginPrompt) => {
        // 表单式登录：把 prompt 挂到任务上等前端渲染，返回一个「用户提交后才 resolve」
        // 的 promise。取消时（abort）reject，让 login() 的 promise 立刻结束。
        return new Promise<string>((resolve, reject) => {
          if (task.state !== 'running') {
            reject(new Error('登录已取消'));
            return;
          }
          task.prompt = prompt;
          task.answer = resolve;
          const onAbort = () => {
            task.prompt = null;
            task.answer = undefined;
            reject(new Error('登录已取消'));
          };
          controller.signal.addEventListener('abort', onAbort, { once: true });
          emitLogin(task);
        });
      },
      signal: controller.signal,
    })
    .then((result) => {
      // 已经被取消的任务不许再落成账号：否则用户点了「取消」，几分钟后
      // 浏览器那边又完成授权，凭据会悄悄写回来，把它刚放弃的号复活。
      if (task.state !== 'running') {
        log(`${channel.id} 登录结果作废（任务已 ${task.state}）`);
        return;
      }
      const account = materializeAccount(channel, result);
      task.state = 'done';
      task.finishedAt = Date.now();
      task.accountId = account?.id;
      log(`${channel.id} 登录成功 → ${account?.id || '(未落成账号)'}`);
      emitLogin(task);
    })
    .catch((error: any) => {
      if (task.state === 'cancelled') {
        log(`${channel.id} 登录已取消`);
        return;
      }
      task.state = 'error';
      task.finishedAt = Date.now();
      task.message = error && error.message ? error.message : String(error);
      log(`${channel.id} 登录失败：${task.message}`);
      emitLogin(task);
    });
  return { ok: true, task };
}

/**
 * 取消一次正在跑的登录。
 *
 * 为什么需要它：登录最长等 5 分钟，而用户可能在浏览器里点错了、或者根本不想登了。
 * 卡在「进行中」时唯一的出路是再点一次「添加账号」——那会掐掉旧的再起新的，
 * **等于重来一遍**，不是取消。所以给一个明确的「取消」。
 *
 * 取消后任务状态变 `cancelled`（不是 `error`）：它不是故障，是用户的选择。
 */
export function cancelLogin(channelId: string, taskId: string): boolean {
  const task = loginTasks.get(taskKey(channelId, taskId));
  if (!task) return false;
  if (task.state !== 'running') return false;
  task.state = 'cancelled';
  task.finishedAt = Date.now();
  task.message = '已取消';
  task.prompt = null;
  task.answer = undefined;
  // abort 会打断轮询里的 sleep 和 fetch，login() 的 promise 随之 reject；
  // 上面那个 catch 看到 state 已是 cancelled 就只记一行日志。
  task.controller?.abort();
  log(`${channelId} 登录 ${taskId} 被用户取消`);
  // 取消也要推：插件据此把已经开好的回调转发关掉，不留一个没人要的监听端口。
  emitLogin(task);
  return true;
}

/**
 * 表单式登录：用户提交一个值，回填给正在等输入的 prompt。
 *
 * 返回 `false` 表示没有对应 prompt（任务已结束、已取消，或压根不是表单式登录）。
 * 幂等由 `answer` 的消费保证：resolve 一次之后 `task.answer` 被置空，重复提交无效。
 */
export function answerLoginPrompt(channelId: string, taskId: string, value: string): boolean {
  const task = loginTasks.get(taskKey(channelId, taskId));
  if (!task || task.state !== 'running' || !task.prompt || typeof task.answer !== 'function') return false;
  const answer = task.answer;
  task.prompt = null;
  task.answer = undefined;
  answer(value);
  return true;
}

/** 取消某个通道上所有还在跑的任务（「再点一次登录」时用）。 */
export function cancelRunningLogins(channelId: string): number {
  let count = 0;
  for (const task of loginTasks.values()) {
    if (task.channelId === channelId && task.state === 'running') {
      task.state = 'cancelled';
      task.finishedAt = Date.now();
      task.message = '已被新的登录取代';
      task.controller?.abort();
      emitLogin(task);
      count += 1;
    }
  }
  return count;
}
