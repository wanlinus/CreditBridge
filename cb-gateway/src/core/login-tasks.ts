// 一次登录任务的进度。前端轮询 `GET /api/accounts/<channel>/login/<taskId>` 读它。
// 登录是交互式且可能阻塞几分钟的，所以起点是「起一个后台任务、立刻返回句柄」。任务只负责
// 拿到凭据并落成账号——它是「登录 → 账号」的接缝。

import type { Account, Channel, LoginPrompt } from '../types.ts';
import { log } from '../logger.ts';
import { accountsOf, addAccount, findAccountByUid, getAccount, markReady, updateAccount } from './accounts.ts';
import { publishEvent } from './events.ts';

export interface LoginTask {
  taskId: string;
  channelId: string;
  /** `cancelled` 是**用户主动放弃**，和 `error` 分开：页面话术不同，且迟到的授权结果要作废。 */
  state: 'running' | 'done' | 'error' | 'cancelled';
  url: string | null;
  /** 表单式登录当前要用户填的一步；URL 式登录恒为 null。 */
  prompt: LoginPrompt | null;
  message: string | null;
  startedAt: number;
  finishedAt: number | null;
  /** 回调要不要「浏览器那台机器」把 127.0.0.1:<port> 转进来。起任务时算一次存下来。 */
  loopback: { port: number; path: string } | null;
  accountId?: string;
  /**
   * 上游要求用户完成验证（图形验证码）时带上，界面据此渲染验证页。
   * **为空不代表没风控**：豆包 2046 走的是登录流程里的 `prompt`（二维码/短信号码），
   * 不是这条路径。
   */
  challenge?: { url: string; code: string; subtype: string } | null;
  /** 用来掐掉上一次：用户再点一次「登录」就是重来一遍，不该干等 5 分钟。 */
  controller?: AbortController;
  /** 当前 prompt 的应答器（用户提交后 resolve，取消后 reject）。 */
  answer?: (value: string) => void;
}

/** 键是 `<channelId>:<taskId>`。 */
const loginTasks = new Map<string, LoginTask>();

/** 保证同一毫秒内的两次登录不会撞号（见 `startLogin`）。 */
let loginTaskSeq = 0;

function taskKey(channelId: string, taskId: string) {
  return `${channelId}:${taskId}`;
}

export function getLoginTask(channelId: string, taskId: string): LoginTask | undefined {
  return loginTasks.get(taskKey(channelId, taskId));
}

/** `controller` / `answer` 不能序列化，也不该出现在响应里。 */
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
    challenge: task.challenge ?? null,
  };
}

/** **不做队列重放**：插件断线期间的事件就该丢，补发过期的「登录中」只会让它去开个废端口。 */
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
 * 登录成功后把凭据变成一条账号记录，按优先级：上游 uid 已存在就复用那个号 → 单账号通道
 * 覆盖它唯一那个号 → 其余新建（序号由账号层分配，只增不减）。
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
 * 起一次登录。同通道已有任务在跑时怎么处理，**取决于那个任务在等什么**：
 *
 * - **正在等用户输入（有 `prompt`）→ 复用，不取消。** 此刻取消代价最高：验证码已经发到
 *   用户手机上了，取消就要等 60 秒才能重发。而用户重复点「登录」多半是误触或刷新页面，
 *   不是真想重来。
 * - **在等上游（没 `prompt`，比如 URL 式登录迟迟不给授权地址）→ 掐掉重起。** 那种时候
 *   「卡住」是真的，用户能做的唯一一件事就是再点一次，复用会让这次点击变成无操作。
 *
 * 2026-11-26 踩过全掐的版本：用户在收验证码时误点了一下，整条登录被取消、输入框消失，
 * 而他并不知道自己做了什么。
 */
export function startLogin(channel: Channel): { ok: boolean; task?: LoginTask; error?: string } {
  if (typeof channel.login !== 'function') return { ok: false, error: `${channel.label} 不支持自助登录` };

  // 有 prompt 在等输入 = 已经走到问用户话了，复用它。
  const waiting = [...loginTasks.values()].find(
    (item) => item.channelId === channel.id && item.state === 'running' && item.prompt !== null,
  );
  if (waiting) {
    log(`${channel.id} 已有任务在等用户输入（${waiting.taskId}），复用而不是重起`);
    return { ok: true, task: waiting };
  }

  // 单账号通道已经有号时，登录的含义是「重新登录这个号」，仍然允许。
  const cancelled = cancelRunningLogins(channel.id);
  if (cancelled > 0) log(`${channel.id} 重新发起登录，取消了 ${cancelled} 个未完成任务`);

  const controller = new AbortController();
  // **不能只用 `Date.now()`**：同一毫秒里连点两次会撞同一个 taskId，两个任务共用一条 Map
  // 键，第二次把第一次覆盖掉——表现是「点两次登录只有一个任务，前一个永远 running」。
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
    loopback: typeof channel.loginLoopback === 'function' ? channel.loginLoopback() : null,
    controller,
  };
  loginTasks.set(taskKey(channel.id, taskId), task);
  // 只留最近 20 个任务：内存里的临时状态，没人在意一小时前的进度。
  if (loginTasks.size > 20) {
    const oldest = [...loginTasks.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt)[0];
    if (oldest) loginTasks.delete(oldest[0]);
  }
  // **先推再起 login()**：插件要在这个端口上开好转发，用户的浏览器才可能跳回来。晚推一步
  // 的结果是「授权完成但没人接」，用户看到的就是登录失败。
  emitLogin(task);

  channel
    .login({
      onUrl: (url: string) => {
        task.url = url;
      },
      onPrompt: (prompt: LoginPrompt) => {
        // 把 prompt 挂到任务上等前端渲染，返回一个「用户提交后才 resolve」的 promise。
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
      // 已被取消的任务不许再落成账号：否则用户点了「取消」、几分钟后浏览器又完成授权，
      // 凭据会悄悄写回来，把它刚放弃的号复活。
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
      // 上游出了验证题就带给界面（图形验证码走这条；2046 的二维码走 prompt）。
      if (error && error.challenge) task.challenge = error.challenge;
      log(`${channel.id} 登录失败：${task.message}`);
      emitLogin(task);
    });
  return { ok: true, task };
}

/** 取消一次正在跑的登录。状态变 `cancelled`（不是 `error`）——它不是故障，是用户的选择。 */
export function cancelLogin(channelId: string, taskId: string): boolean {
  const task = loginTasks.get(taskKey(channelId, taskId));
  if (!task) return false;
  if (task.state !== 'running') return false;
  task.state = 'cancelled';
  task.finishedAt = Date.now();
  task.message = '已取消';
  task.prompt = null;
  task.answer = undefined;
  // abort 会打断轮询里的 sleep 和 fetch，login() 的 promise 随之 reject。
  task.controller?.abort();
  log(`${channelId} 登录 ${taskId} 被用户取消`);
  // 取消也要推：插件据此把回调转发关掉，不留没人要的监听端口。
  emitLogin(task);
  return true;
}

/** 表单式登录：用户提交一个值，回填给正在等输入的 prompt。幂等由 `answer` 被置空保证。 */
export function answerLoginPrompt(channelId: string, taskId: string, value: string): boolean {
  const task = loginTasks.get(taskKey(channelId, taskId));
  if (!task || task.state !== 'running' || !task.prompt || typeof task.answer !== 'function') return false;
  const answer = task.answer;
  task.prompt = null;
  task.answer = undefined;
  answer(value);
  return true;
}

/** 取消某个通道上所有还在跑的任务。 */
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
