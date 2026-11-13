import { onBeforeUnmount, ref, shallowRef, type Ref } from 'vue';

import { cancelLoginTask, answerLoginPrompt, getLoginTask, startLogin, type LoginTask } from '@/api/accounts';
import { ApiError } from '@/api/client';

const POLL_MS = 1200;

export interface LoginTaskOptions {
  onFirstUrl?: (url: string) => void;
  onSettled?: (task: LoginTask) => void;
}

export interface LoginTaskController {
  task: Ref<LoginTask | null>;
  urls: Ref<string[]>;
  error: Ref<string | null>;
  busy: Ref<boolean>;
  start: (channelId: string) => Promise<LoginTask>;
  resume: (channelId: string, taskId: string) => Promise<void>;
  answer: (value: string) => Promise<void>;
  cancel: () => Promise<void>;
  reset: () => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useLoginTask(options: LoginTaskOptions = {}): LoginTaskController {
  const task = shallowRef<LoginTask | null>(null);
  const urls = ref<string[]>([]);
  const error = ref<string | null>(null);
  const busy = ref(false);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let watching: { channelId: string; taskId: string } | null = null;

  function stop(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function apply(next: LoginTask): void {
    task.value = next;
    if (next.url && !urls.value.includes(next.url)) {
      urls.value = [...urls.value, next.url];
      if (urls.value.length === 1) options.onFirstUrl?.(next.url);
    }
    if (next.state !== 'running') {
      stop();
      watching = null;
      options.onSettled?.(next);
    }
  }

  function schedule(channelId: string, taskId: string): void {
    stop();
    timer = setTimeout(() => void poll(channelId, taskId), POLL_MS);
  }

  async function poll(channelId: string, taskId: string): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      const next = await getLoginTask(channelId, taskId);
      if (!watching || watching.taskId !== taskId) return;
      apply(next);
    } catch (err) {
      if (!watching || watching.taskId !== taskId) return;
      if (err instanceof ApiError && err.status === 404) {
        const stale = task.value;
        if (stale) {
          apply({ ...stale, state: 'error', message: '这次登录任务已经不在网关上了（网关重启过？）。重新发起一次即可。' });
        } else {
          error.value = '这次登录任务已经不在网关上了（网关重启过？）。重新发起一次即可。';
          stop();
          watching = null;
        }
      } else {
        error.value = messageOf(err);
        schedule(channelId, taskId);
      }
    } finally {
      inFlight = false;
    }
    if (task.value?.state === 'running' && watching?.taskId === taskId) {
      schedule(channelId, taskId);
    }
  }

  async function start(channelId: string): Promise<LoginTask> {
    busy.value = true;
    error.value = null;
    urls.value = [];
    stop();
    try {
      const { task: created } = await startLogin(channelId);
      watching = { channelId, taskId: created.taskId };
      apply(created);
      schedule(channelId, created.taskId);
      return created;
    } catch (err) {
      error.value = messageOf(err);
      throw err;
    } finally {
      busy.value = false;
    }
  }

  async function resume(channelId: string, taskId: string): Promise<void> {
    error.value = null;
    task.value = null;
    urls.value = [];
    watching = { channelId, taskId };
    await poll(channelId, taskId);
  }

  async function answer(value: string): Promise<void> {
    const current = task.value;
    if (!current) return;
    busy.value = true;
    error.value = null;
    try {
      await answerLoginPrompt(current.channelId, current.taskId, value);
      await poll(current.channelId, current.taskId);
    } catch (err) {
      error.value = messageOf(err);
    } finally {
      busy.value = false;
    }
  }

  async function cancel(): Promise<void> {
    const current = task.value;
    if (!current) return;
    busy.value = true;
    try {
      await cancelLoginTask(current.channelId, current.taskId);
      stop();
      watching = null;
      task.value = { ...current, state: 'cancelled', finishedAt: Date.now() };
      options.onSettled?.(task.value);
    } catch (err) {
      error.value = messageOf(err);
    } finally {
      busy.value = false;
    }
  }

  function reset(): void {
    stop();
    watching = null;
    task.value = null;
    urls.value = [];
    error.value = null;
  }

  onBeforeUnmount(stop);

  return { task, urls, error, busy, start, resume, answer, cancel, reset };
}
