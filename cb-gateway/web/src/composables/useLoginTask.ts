/**
 * 登录任务的轮询控制器。
 *
 * ## 为什么是轮询，而不是文档 §7.5 说的 SSE
 *
 * 那一节写的是「SPA 用 `EventSource('/api/events')`，轮询降级为兜底」。实测下来
 * **SSE 替代不了轮询**：`core/login-tasks.ts` 的 `emitLogin()` 只推
 * `{ type, channelId, taskId, state, loopback, message }`——**没有 `url`，也没有 `prompt`**。
 * 而这两样正是登录过程中唯一需要用户看见的东西。所以 SSE 最多省下 1.2 秒的延迟，
 * 换来的是「两条通道各自维护状态、还得防交叉覆盖」。这里只留轮询。
 *
 * ## 三个必须踩对的点（都是旧页面 `ui/accounts.ts` 用注释记下来的）
 *
 * 1. **URL 按「变化」处理，不是「第一个」**：Qoder 的登录要授权两次（先设备流拿额度/
 *    签到凭据、再 CLI 拿对话态），只认第一个 URL 会让用户卡在「进行中」。
 * 2. **`cancelled` 不是失败**：任务状态四档，取消要显示成「已取消」并给一条重来的路。
 * 3. **任务句柄放地址栏 query**：刷新能接上。网关侧的任务不因浏览器刷新而消失。
 */
import { onBeforeUnmount, ref, shallowRef, type Ref } from 'vue';

import { cancelLoginTask, answerLoginPrompt, getLoginTask, startLogin, type LoginTask } from '@/api/accounts';
import { ApiError } from '@/api/client';

/** 轮询间隔。旧页面是 1500ms，这里略快一点：登录面板是「盯着看」的场景。 */
const POLL_MS = 1200;

export interface LoginTaskOptions {
  /**
   * 第一次拿到授权链接时调用。
   *
   * **必须是同步回调**，调用方要在点「确认登录」的同一轮事件里先把空白窗开好，
   * 否则弹窗拦截会让自动打开静默失败（旧页面为此专门等到 url 才返回页面，
   * 那次阻塞的目的就是借用用户手势）。
   */
  onFirstUrl?: (url: string) => void;
  /** 任务结束（done / error / cancelled）时调用一次。 */
  onSettled?: (task: LoginTask) => void;
}

export interface LoginTaskController {
  task: Ref<LoginTask | null>;
  /** 出现过的授权链接，按出现顺序去重。 */
  urls: Ref<string[]>;
  /** 操作级错误（起任务失败、回填失败、取消失败）。任务本身的失败在 `task.message`。 */
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
  /** 当前轮询的是哪个任务。`reset()` 之后旧请求回来也不能覆盖新任务。 */
  let watching: { channelId: string; taskId: string } | null = null;

  function stop(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /** 收下一个任务快照：补 URL 历史、判结束。 */
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
    // 上一轮还没回来就不要再发：慢请求会让轮询堆积，回来的顺序还可能是乱的。
    if (inFlight) return;
    inFlight = true;
    try {
      const next = await getLoginTask(channelId, taskId);
      if (!watching || watching.taskId !== taskId) return;
      apply(next);
    } catch (err) {
      if (!watching || watching.taskId !== taskId) return;
      if (err instanceof ApiError && err.status === 404) {
        // 联网关重启：任务表是内存态，重启就没了。当成失败处理并说明原因，
        // 别让人对着一个永远「进行中」的面板等 5 分钟。
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
      // 立刻拉一次：通道拿到值后要么发下一个 prompt、要么完成，都在这份快照里。
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
