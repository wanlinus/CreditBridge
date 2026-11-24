// 入口。
//
// 装配顺序：配置日志 → 收紧凭据目录权限 → 给每个通道注入上下文 → 建 Hono 应用
// → 起 HTTP 服务。加通道不需要动这个文件：通道从 `channels/index.ts` 发现。

import { serve } from '@hono/node-server';

import { config } from './config.ts';
import { configureLogger, log } from './logger.ts';
import { channels } from './channels/index.ts';
import { loadAccounts } from './core/accounts.ts';
import { hasAnyCredential } from './core/keys.ts';
import { createApp } from './app.ts';
import { restrictAuthDirPermissions } from './shared/data-permissions.ts';
import { setShutdownHandler, startParentWatchdog, warmupChannels } from './lifecycle.ts';

configureLogger({ verbose: config.verbose });

// 凭据是明文 token，先把 data/ 的 ACL 收紧到当前用户（Windows 上 fs 的 mode 不生效）。
// v4 起凭据都在 `data/gateway.db` 里，而 WAL 还会带出 `-wal` / `-shm` 两个附属文件，
// 所以范围是整个目录而不是某几个文件。异步执行，不挡启动。
restrictAuthDirPermissions(log);

// 账号要在通道 configure 之前加载：日志里那句「有几个号」和路由层的账号查询都
// 依赖这份内存副本。
loadAccounts();

for (const channel of channels) {
  channel.configure?.({ log, config });
}

const app = createApp();

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () => {
  log(`Agent gateway listening on http://${config.host}:${config.port}`);
  // 一条 key 都没有时，所有程序调用都会 401，而 `/keys` 页要先登录才能进。
  // 这条日志是「新部署第一步该干什么」的唯一提示，别省。
  if (!hasAnyCredential()) {
    log('还没有任何 API key：DSH 和脚本调用会 401。打开 /login 登录后去 /keys 建一把。');
  }
  warmupChannels();
  startParentWatchdog(server);
});

setShutdownHandler(() => {
  log('shutdown requested over HTTP; stopping');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref?.();
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log(`收到 ${signal}，正在关闭`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  });
}

process.on('unhandledRejection', (error: any) => log(`未处理的 Promise 拒绝：${error?.stack || error}`));

/**
 * 同步代码里没人接的异常。
 *
 * ## 为什么必须兜底
 *
 * `unhandledRejection` 管的是「async 抛错没人 catch」，Node 会打警告后**继续跑**。
 * 而 `uncaughtException` 管的是「同步代码抛错没人 catch」，Node 的默认行为是
 * **直接退出进程**——容器有 `restart: unless-stopped` 会把它拉起来，但：
 *
 *   ① **在途请求全部断掉**。网关一个对话请求要 3 秒，正好崩在中间时，
 *      用户看到的是「对话突然中断」，而不是一个能读的错误；
 *   ② 日志里只有 Node 打印到 stderr 的默认堆栈，**进不了 `data/logs/`**，
 *      没法和其他日志按时间对齐（比如「崩溃前最后一个请求是哪个账号」）。
 *
 * ## 为什么退出码是 1
 *
 * `1` 让 `docker compose logs` 和运维脚本能区分「异常退出」和「正常停机（0）」。
 * 这类崩溃一个月不出现一次，出现时必须一眼看出来是哪种。
 *
 * ## 为什么不尝试恢复运行
 *
 * Node 官方明确说 `uncaughtException` 之后恢复是不安全的：你不知道哪个连接卡在半路、
 * 哪个定时器还在跑、哪个 Promise 永远等不到结果。所以这里只做两件事——
 * **把现场写进日志**，然后退出。
 *
 * 先 `server.close()` 是给在途请求一点时间把响应写完（最多 1.5 秒）。
 */
process.on('uncaughtException', (error: any) => {
  log(`未捕获的异常，进程即将退出：${error?.stack || error}`);
  server.close(() => process.exit(1));
  // 兜底：close 的回调在极端情况下不会来（连接挂死），1.5 秒后强退。
  setTimeout(() => process.exit(1), 1500).unref?.();
});
