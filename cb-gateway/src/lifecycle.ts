import { log } from './logger.ts';
import { channels } from './channels/index.ts';
import { accountsOf } from './core/accounts.ts';
import { startCheckinScheduler } from './core/checkin-scheduler.ts';

let shutdownHandler: (() => void) | null = null;

export function setShutdownHandler(fn: () => void) {
  shutdownHandler = fn;
}

export function requestShutdown() {
  if (shutdownHandler) shutdownHandler();
  else log('收到停机请求，但没有注册停机处理器');
}

export function startParentWatchdog(server: any) {
  const arg = process.argv.find((value) => value.startsWith('--parent-pid='));
  if (!arg) return;
  const parentPid = Number(arg.slice('--parent-pid='.length));
  if (!Number.isInteger(parentPid) || parentPid <= 0) return;
  log(`supervised by pid ${parentPid}; will exit when that process does`);
  const timer = setInterval(() => {
    try {
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

export function warmupChannels() {
  for (const channel of channels) {
    const accounts = accountsOf(channel.id);
    if (accounts.length === 0) {
      log(`${channel.id}: 没有账号，去 /accounts 加一个`);
      continue;
    }
    const summary = accounts.map((account) => `${account.id}=${account.status}`).join(' ');
    log(`${channel.id} (${channel.idPrefix}) 账号 ${accounts.length} 个：${summary}`);
    for (const account of accounts) {
      if (account.status !== 'ready' || typeof channel.warmup !== 'function') continue;
      channel
        .warmup(account)
        .catch((error: any) => log(`${account.id} warmup failed: ${error.message}`));
    }
  }
  startCheckinScheduler();
}
