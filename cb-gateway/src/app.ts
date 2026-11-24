// Hono 应用：中间件 + 路由挂载。
//
// 这个文件只做编排，不认识任何具体通道。三组入口：
//   /v1/*    OpenAI 兼容（模型列表、对话）——只认 API key
//   /api/*   管理 API（账号、key、用量、可见性、登录、改密）
//   其余一切  前端 SPA 的静态产物与 fallback（壳是公开的，数据全在 `/api/*` 后面）
//
// 服务端**不再渲染任何 HTML**：登录页、改密页、账号页都在 `web/` 里。
// 2026-11-13 之前这里还挂着 8 个 SSR 页面（`routes/pages.ts` + `src/ui/`），那套已经删干净。
//
// 为什么从 `node:http` 换到 Hono：手写路由的 40 多个 `if`、每处各自的 try/catch、
// 手写的 SSE 头处理，都是框架的标准职责。判据和代价写在 `private/docs/v2/README.md` §9。

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

/** 拿到原生 `IncomingMessage` / `ServerResponse` 用（SSE 和遗留 handler 需要）。 */
export type AppEnv = { Bindings: HttpBindings };

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
/** 前端产物目录。从 `src/app.ts` 出发指向 `cb-gateway/web/dist`。 */
const WEB_DIST = path.join(APP_DIR, '..', 'web', 'dist');
const WEB_INDEX = path.join(WEB_DIST, 'index.html');

/** 前端构建过没有。没构建时给一条能看懂的提示，而不是一个 404。 */
function webDistReady(): boolean {
  return fs.existsSync(WEB_INDEX);
}

/**
 * 前端子应用：静态产物 + SPA fallback。
 *
 * 三条踩过的规矩：
 *
 * ① **fallback 只能是 `get('*')`**，不能写成第二条 `use('*', serveStatic({path}))`：
 *    后者不看请求路径、无条件回同一个文件，会把 `/api/*` 也接走回 index.html，
 *    表现是面板白屏而服务端日志全是 200。
 * ② **挂在所有 API 路由之后**——Hono 按注册顺序匹配，这个是兜底。
 * ③ **壳必须 `no-cache`，而壳是 `serveStatic` 直接回的**，不经过 `get('*')`。
 */
function createSpaApp() {
  const spa = new Hono<AppEnv>();

  spa.use(
    '*',
    serveStatic({
      root: WEB_DIST,
      /**
       * 带内容哈希的资源可以长缓存；**壳必须 `no-cache`，而且它也是从这里出去的**
       * ——`serveStatic` 对 `/` 直接回 `index.html`，根本不走下面的 `get('*')`。
       * 只在 `get('*')` 里设头的话，最常访问的 `/` 反而没有头。
       */
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
    /**
     * 带 `api/` 或 `v1/` 段的路径不能落到壳上：回 HTML 会让调用方拿到
     * `Unexpected token '<'`，比 404 JSON 难查得多。判的是「路径里出现这个段」
     * 而不是「以它开头」——v1 时代的 `/workbuddy/v1/models` 也得回 404。
     */
    if (/\/(?:api|v1)\//u.test(pathname)) {
      return c.json({ error: { message: `没有这个接口：${pathname}`, type: 'not_found' } }, 404);
    }
    if (!webDistReady()) {
      return c.text(
        `前端还没构建。在 cb-gateway/web 下跑一次 pnpm build，或直接 npm start（会先构建）。`,
        503,
      );
    }
    // 壳每次都要验证：它的 URL 永远不变但内容随构建变，按启发式缓存会拿到旧壳，
    // 而旧壳引用的是已被删掉的 assets/index-<旧哈希>.js —— 界面白屏、日志全是 200。
    c.header('Cache-Control', 'no-cache');
    // 每次现读：改完前端刷新就能看到，不用重启网关。文件不到 1KB，这点 IO 很便宜。
    return c.html(fs.readFileSync(WEB_INDEX, 'utf8'));
  });

  return spa;
}

const LOOPBACK_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/iu;
const TRUSTED_ORIGIN_RE =
  /^(?:https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?|dsh-app:\/\/[A-Za-z0-9._-]+)$/iu;
const LOOPBACK_BIND_RE = /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/iu;

/**
 * POST 闸只在网关绑环回时启用。
 *
 * 它保护的是「只有本机能访问」的服务，防跨站表单借浏览器打 127.0.0.1。绑
 * `0.0.0.0`（容器部署）时请求天然来自别的机器，Host 永远不是环回，闸留着只会
 * 把自己的 DSH 拦在门外。所以跟着监听地址走，不加配置项。
 */
function loopbackGateActive(): boolean {
  return LOOPBACK_BIND_RE.test(String(config.host));
}

function loopbackHost(host: string | undefined): boolean {
  if (typeof host !== 'string' || host === '') return true;
  return LOOPBACK_HOST_RE.test(host);
}

export function createApp() {
  const app = new Hono<AppEnv>();

  // ---- 请求日志：状态码只能等响应生成后才知道，所以包在 next() 前后 ----
  app.use('*', async (c, next) => {
    const started = Date.now();
    await next();
    const origin = c.req.header('origin');
    const tag = origin ? ` origin=${origin}` : '';
    log(`http ${c.req.method} ${new URL(c.req.url).pathname} -> ${c.res.status} ${Date.now() - started}ms${tag}`);
  });

  // ---- CORS：只对可信来源回显 ----
  //
  // 白名单必须包含 `dsh-app://`——那是 DSH 渲染进程的自定义协议，不是 http。
  // 只放行 127.0.0.1/localhost 会让插件里所有请求静默失效：网关回 200，浏览器
  // 把响应体扣下，面板只看到 fetch 失败。
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

  // ---- Host 闸（仅环回绑定 + POST）----
  app.use('*', async (c, next) => {
    if (c.req.method === 'POST' && loopbackGateActive() && !loopbackHost(c.req.header('host'))) {
      return c.json(
        { error: { message: `host not allowed: ${c.req.header('host')}`, type: 'forbidden' } },
        403,
      );
    }
    return next();
  });

  // ---- 两道闸：先认证，再强制改密 ----
  //
  // 都只作用于 `/api/*` 与 `/v1/*`：SPA 的壳和静态资源是公开的（它就是几行 script 标签），
  // 数据全在后面那些接口上。这样登录页在**没有任何凭据**时也能加载出来——否则就是死锁。
  app.use('*', authGate);
  app.use('*', passwordGate);

  // ---- `/v1/*` 再收一道：只认 Bearer key ----
  //
  // `authGate` 对任何 API 路径都两种凭据都认（浏览器要用 Cookie 开管理台）。但 `/v1/*`
  // 是**程序协议入口**，它的凭据模型是一把能单独吊销的 key，文档也一直这么写。
  // 放在 `authGate` 之后、路由之前：认证失败已经由前者回 401，这里只是把「Cookie 通过
  // 的那部分」拦住，所以能给出更准确的错误文案（说的是「带 key」而不是「先登录」）。
  app.use('/v1/*', bearerOnlyGate);

  // ---- 路由 ----
  //
  // **没有通道前缀路由了**（v2）：v1 最后的 `/<prefix>/*` 是 catch-all 兜底，
  // 必须排在 `/v1/*` 后面才不会抢走无前缀路径。现在通道只作为模型 id 的前半段
  // 存在（`wb-1/hy4free`），路由表是固定的四组。
  app.route('/', accountsRoutes);
  app.route('/', keysRoutes);
  app.route('/', adminRoutes);
  app.route('/', jsonActionRoutes);
  app.route('/v1', openaiRoutes);
  // **前端子应用必须最后挂**：它是兜底，只接前面没人认领的 GET。
  // 挂在前面会把 `/api/*` 一起接走回 index.html（2026-11-12 踩过）。
  app.route('/', createSpaApp());

  app.notFound((c) => {
    const pathname = new URL(c.req.url).pathname;
    // 走到这里只剩「非 GET 且不是任何 API 路由」的请求：POST/PUT/DELETE 打到一个不存在
    // 的路径。浏览器不会这么发，所以一律按接口错误回 JSON。
    return c.json({ error: { message: `no route: ${c.req.method} ${pathname}`, type: 'not_found' } }, 404);
  });

  app.onError((error, c) => {
    log(`未捕获的路由错误 ${c.req.method} ${new URL(c.req.url).pathname}: ${error?.stack || error}`);
    return c.json({ error: { message: String(error?.message || error), type: 'gateway_error' } }, 500);
  });

  return app;
}
