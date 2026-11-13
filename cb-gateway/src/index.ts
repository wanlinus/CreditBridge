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

restrictAuthDirPermissions(log);

loadAccounts();

for (const channel of channels) {
  channel.configure?.({ log, config });
}

const app = createApp();

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () => {
  log(`Agent gateway listening on http://${config.host}:${config.port}`);
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
