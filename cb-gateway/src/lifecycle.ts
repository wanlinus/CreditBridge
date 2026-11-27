// 进程生命周期：停机钩子、父进程看护、启动预热。单独成模块是因为 `/api/shutdown` 在路由里，
// 而它要关的 server 实例在入口创建——两边互相引用会成环。这里放一个回调槽，入口注册、路由触发。

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

/** 可选的父进程看护：带 `--parent-pid=<pid>` 启动时，网关在那个进程消失后退出。不能反过来在 DSH 里挂退出钩子：DSH 可能被强杀，而被杀的进程不会执行任何钩子，轮询父进程是否存在才可靠。 */
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
 * 启动后的收尾：打印每个通道挂了哪些号，然后起签到调度（每天到 `checkinTime` 点跑一次，不是轮询）。
 *
 * **不打上游**：启动时验活只会让冷启动变慢、把日志刷满，要验活去管理台点「检测」。
 * 曾经这里还有个 `warmup()` 钩子给 Trae 垫账本基线（积分逐请求做差的年代），
 * 那个机制 2026-11-13 删掉后钩子就没人实现了，一起删。
 */
export function reportStartupState() {
  for (const channel of channels) {
    const accounts = accountsOf(channel.id);
    if (accounts.length === 0) {
      log(`${channel.id}: 没有账号，去 /accounts 加一个`);
      continue;
    }
    const summary = accounts.map((account) => `${account.id}=${account.status}`).join(' ');
    log(`${channel.id} (${channel.idPrefix}) 账号 ${accounts.length} 个：${summary}`);
  }
  startCheckinScheduler();
}
