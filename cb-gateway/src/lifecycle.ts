// 进程生命周期：停机钩子、父进程看护、启动预热。
//
// 单独成模块是因为 `/api/shutdown` 在路由里，而它要关的 server 实例在入口创建——
// 两边互相引用会成环。这里放一个回调槽，入口注册、路由触发。

import { log } from './logger.ts';
import { channels } from './channels/index.ts';
import { accountsOf } from './core/accounts.ts';
import { startCheckinScheduler } from './core/checkin-scheduler.ts';

let shutdownHandler: (() => void) | null = null;

/** 入口创建 server 之后注册：声明「收到停机请求时做什么」。 */
export function setShutdownHandler(fn: () => void) {
  shutdownHandler = fn;
}

/** 路由层调用：`POST /api/shutdown`。没注册时只记日志。 */
export function requestShutdown() {
  if (shutdownHandler) shutdownHandler();
  else log('收到停机请求，但没有注册停机处理器');
}

/**
 * 可选的父进程看护：带 `--parent-pid=<pid>` 启动时，网关在那个进程消失后退出。
 *
 * 不能反过来在 DSH 里挂退出钩子：DSH 可能被强杀，而被杀的进程不会执行任何钩子。
 * 轮询父进程是否存在才是可靠的方向。
 */
export function startParentWatchdog(server: any) {
  const arg = process.argv.find((value) => value.startsWith('--parent-pid='));
  if (!arg) return;
  const parentPid = Number(arg.slice('--parent-pid='.length));
  if (!Number.isInteger(parentPid) || parentPid <= 0) return;
  log(`supervised by pid ${parentPid}; will exit when that process does`);
  const timer = setInterval(() => {
    try {
      // signal 0 只做存在性检查，不真的发信号。
      process.kill(parentPid, 0);
    } catch {
      log(`supervisor pid ${parentPid} is gone; shutting down`);
      clearInterval(timer);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1000).unref?.();
    }
  }, 5000);
  timer.unref?.();
}

/**
 * 监听成功后的预热。
 *
 * **只读本地状态，不发网络请求**——除了通道自述的 `warmup()`（例如 Trae 要垫结算
 * 基线，那是它自己的账号接口，走它自己的错误处理）。启动时打一遍上游只会让冷启动
 * 变慢、把日志刷满，不代表网关有问题；要验活去管理台点「检测」。
 *
 * 顺便把签到调度起起来（每天到 `checkinTime` 点跑一次，失败的按阶梯重试；不是轮询）。
 */
export function warmupChannels() {
  for (const channel of channels) {
    const accounts = accountsOf(channel.id);
    if (accounts.length === 0) {
      log(`${channel.id}: 没有账号，去 /accounts 加一个`);
      continue;
    }
    const summary = accounts.map((account) => `${account.id}=${account.status}`).join(' ');
    log(`${channel.id} (${channel.idPrefix}) 账号 ${accounts.length} 个：${summary}`);
    // 预热只对 ready 的号做：坏凭据的预热只会多一条 401。
    for (const account of accounts) {
      if (account.status !== 'ready' || typeof channel.warmup !== 'function') continue;
      channel
        .warmup(account)
        .catch((error: any) => log(`${account.id} warmup failed: ${error.message}`));
    }
  }
  startCheckinScheduler();
}
