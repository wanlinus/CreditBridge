import type { Account, Channel, LoginPrompt } from '../types.ts';
import { log } from '../logger.ts';
import { accountsOf, addAccount, findAccountByUid, getAccount, markReady, updateAccount } from './accounts.ts';
import { publishEvent } from './events.ts';

export interface LoginTask {
  taskId: string;
  channelId: string;
  state: 'running' | 'done' | 'error' | 'cancelled';
  url: string | null;
  prompt: LoginPrompt | null;
  message: string | null;
  startedAt: number;
  finishedAt: number | null;
  loopback: { port: number; path: string } | null;
  accountId?: string;
  controller?: AbortController;
  answer?: (value: string) => void;
}

const loginTasks = new Map<string, LoginTask>();

let loginTaskSeq = 0;

function taskKey(channelId: string, taskId: string) {
  return `${channelId}:${taskId}`;
}

export function getLoginTask(channelId: string, taskId: string): LoginTask | undefined {
  return loginTasks.get(taskKey(channelId, taskId));
}

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

export function startLogin(channel: Channel): { ok: boolean; task?: LoginTask; error?: string } {
  if (typeof channel.login !== 'function') return { ok: false, error: `${channel.label} 不支持自助登录` };
  const cancelled = cancelRunningLogins(channel.id);
  if (cancelled > 0) log(`${channel.id} 重新发起登录，取消了 ${cancelled} 个未完成任务`);

  const controller = new AbortController();
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
  if (loginTasks.size > 20) {
    const oldest = [...loginTasks.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt)[0];
    if (oldest) loginTasks.delete(oldest[0]);
  }
  emitLogin(task);

  channel
    .login({
      onUrl: (url: string) => {
        task.url = url;
      },
      onPrompt: (prompt: LoginPrompt) => {
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

export function cancelLogin(channelId: string, taskId: string): boolean {
  const task = loginTasks.get(taskKey(channelId, taskId));
  if (!task) return false;
  if (task.state !== 'running') return false;
  task.state = 'cancelled';
  task.finishedAt = Date.now();
  task.message = '已取消';
  task.prompt = null;
  task.answer = undefined;
  task.controller?.abort();
  log(`${channelId} 登录 ${taskId} 被用户取消`);
  emitLogin(task);
  return true;
}

export function answerLoginPrompt(channelId: string, taskId: string, value: string): boolean {
  const task = loginTasks.get(taskKey(channelId, taskId));
  if (!task || task.state !== 'running' || !task.prompt || typeof task.answer !== 'function') return false;
  const answer = task.answer;
  task.prompt = null;
  task.answer = undefined;
  answer(value);
  return true;
}

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
