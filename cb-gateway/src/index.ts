// 入口。装配顺序：配置日志 → 收紧凭据目录权限 → 给每个通道注入上下文 → 建 Hono 应用 → 起 HTTP 服务。
// 加通道不需要动这个文件：通道从 `channels/index.ts` 发现。

import { serve } from '@hono/node-server';

import { config } from './config.ts';
import { configureLogger, log } from './logger.ts';
import { channels } from './channels/index.ts';
import { loadAccounts } from './core/accounts.ts';
import { applyCachedIdentities, setVersionsLogger } from './core/channel-versions.ts';
import { hasAnyCredential } from './core/keys.ts';
import { createApp } from './app.ts';
import { restrictAuthDirPermissions } from './shared/data-permissions.ts';
import { setShutdownHandler, startParentWatchdog, reportStartupState } from './lifecycle.ts';

configureLogger({ verbose: config.verbose });

// 凭据是明文 token，先把 data/ 的 ACL 收紧到当前用户（Windows 上 fs 的 mode 不生效）。范围是整个目录而不是
// 某几个文件（WAL 还会带出 `-wal` / `-shm`）。异步执行，不挡启动。
restrictAuthDirPermissions(log);

// 账号要在通道 configure 之前加载：日志里那句「有几个号」和路由层的账号查询都依赖这份内存副本。
loadAccounts();

// 库里的版本号要在 configure 之前覆盖进 identity：configure 会把它转发给各通道模块，
// 之后改就晚了（见 channel-versions.ts 的 applyCachedIdentities）。
setVersionsLogger(log);
applyCachedIdentities();

for (const channel of channels) {
  channel.configure?.({ log, config });
}

const app = createApp();

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () => {
  log(`Agent gateway listening on http://${config.host}:${config.port}`);
  // 一条 key 都没有时，所有程序调用都会 401，而 `/keys` 页要先登录才能进。这条日志是「新部署第一步该干什么」的唯一提示，别省。
  if (!hasAnyCredential()) {
    log('还没有任何 API key：DSH 和脚本调用会 401。打开 /login 登录后去 /keys 建一把。');
  }
  reportStartupState();
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

// 同步代码里没人接的异常。必须兜底：Node 的默认行为是**直接退出进程**，在途请求全部断掉，而日志里只有
// stderr 的默认堆栈、**进不了 `data/logs/`**，没法和其他日志按时间对齐。退出码 1 让 `docker compose logs`
// 能区分「异常退出」和「正常停机（0）」。**不尝试恢复运行**：Node 官方说 `uncaughtException` 之后恢复不安全。
// 先 `server.close()` 是给在途请求一点时间把响应写完（最多 1.5 秒）。
process.on('uncaughtException', (error: any) => {
  log(`未捕获的异常，进程即将退出：${error?.stack || error}`);
  server.close(() => process.exit(1));
  // 兜底：close 的回调在极端情况下不会来（连接挂死），1.5 秒后强退。
  setTimeout(() => process.exit(1), 1500).unref?.();
});
