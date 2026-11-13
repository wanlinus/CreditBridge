import { Hono } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config.ts';
import { log } from './logger.ts';
import { authGate, bearerOnlyGate, passwordGate } from './auth/middleware.ts';
import { openaiRoutes } from './routes/openai.ts';
import { adminRoutes } from './routes/admin.ts';
import { accountsRoutes } from './routes/accounts.ts';
import { keysRoutes } from './routes/keys.ts';
import { jsonActionRoutes } from './routes/json-actions.ts';

export type AppEnv = { Bindings: HttpBindings };

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.join(APP_DIR, '..', 'web', 'dist');
const WEB_INDEX = path.join(WEB_DIST, 'index.html');

function webDistReady(): boolean {
  return fs.existsSync(WEB_INDEX);
}

function createSpaApp() {
  const spa = new Hono<AppEnv>();

  spa.use(
    '*',
    serveStatic({
      root: WEB_DIST,
      onFound: (filepath, c) => {
        if (/[\\/]assets[\\/]/u.test(filepath)) {
          c.header('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          c.header('Cache-Control', 'no-cache');
        }
      },
    }),
  );

  spa.get('*', (c) => {
    const pathname = new URL(c.req.url).pathname;
    if (/\/(?:api|v1)\//u.test(pathname)) {
      return c.json({ error: { message: `没有这个接口：${pathname}`, type: 'not_found' } }, 404);
    }
    if (!webDistReady()) {
      return c.text(
        `前端还没构建。在 cb-gateway/web 下跑一次 pnpm build，或直接 npm start（会先构建）。`,
        503,
      );
    }
    c.header('Cache-Control', 'no-cache');
    return c.html(fs.readFileSync(WEB_INDEX, 'utf8'));
  });

  return spa;
}

const LOOPBACK_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/iu;
const TRUSTED_ORIGIN_RE =
  /^(?:https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?|dsh-app:\/\/[A-Za-z0-9._-]+)$/iu;
const LOOPBACK_BIND_RE = /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/iu;

function loopbackGateActive(): boolean {
  return LOOPBACK_BIND_RE.test(String(config.host));
}

function loopbackHost(host: string | undefined): boolean {
  if (typeof host !== 'string' || host === '') return true;
  return LOOPBACK_HOST_RE.test(host);
}

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    const started = Date.now();
    await next();
    const origin = c.req.header('origin');
    const tag = origin ? ` origin=${origin}` : '';
    log(`http ${c.req.method} ${new URL(c.req.url).pathname} -> ${c.res.status} ${Date.now() - started}ms${tag}`);
  });

  app.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    if (origin && TRUSTED_ORIGIN_RE.test(origin)) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Vary', 'Origin');
    }
    c.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (c.req.method === 'OPTIONS') return c.body(null, 204);
    return next();
  });

  app.use('*', async (c, next) => {
    if (c.req.method === 'POST' && loopbackGateActive() && !loopbackHost(c.req.header('host'))) {
      return c.json(
        { error: { message: `host not allowed: ${c.req.header('host')}`, type: 'forbidden' } },
        403,
      );
    }
    return next();
  });

  app.use('*', authGate);
  app.use('*', passwordGate);

  app.use('/v1/*', bearerOnlyGate);

  app.route('/', accountsRoutes);
  app.route('/', keysRoutes);
  app.route('/', adminRoutes);
  app.route('/', jsonActionRoutes);
  app.route('/v1', openaiRoutes);
  app.route('/', createSpaApp());

  app.notFound((c) => {
    const pathname = new URL(c.req.url).pathname;
    return c.json({ error: { message: `no route: ${c.req.method} ${pathname}`, type: 'not_found' } }, 404);
  });

  app.onError((error, c) => {
    log(`未捕获的路由错误 ${c.req.method} ${new URL(c.req.url).pathname}: ${error?.stack || error}`);
    return c.json({ error: { message: String(error?.message || error), type: 'gateway_error' } }, 500);
  });

  return app;
}
