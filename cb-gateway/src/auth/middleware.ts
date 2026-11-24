// 认证中间件：API key（Bearer）→ 网页会话（Cookie）。
//
// 三道闸，顺序固定：认证 → 强制改密 → （`/v1/*` 上）只认 Bearer。
//
// **只作用于 `/api/*` 和 `/v1/*`。** 其余路径是前端静态产物，它本身不含数据，
// 让壳公开是必须的：登录页在没有任何凭据时也要能加载，否则就是「想进门先给我门钥匙」。
//
// Basic 认证在 v2 删掉了：它每次请求都带密码（base64 不是加密），而 `/keys` 页
// 已经有可单独吊销的 key。

import type { MiddlewareHandler } from 'hono';

import type { AppEnv } from '../app.ts';
import { verifyKey } from '../core/keys.ts';
import { extractBearer, mustChangePassword, sessionFromCookie, sessionValid } from '../shared/gateway-auth.ts';

/** 公开入口。别的 API 一律先过认证闸。 */
const PUBLIC_PATHS = new Set([
  // SPA 用 JSON 端点登录。**它必须在公开名单里**：来登录的人按定义还没有凭据，
  // 让 authGate 拦住它就是「想进门先给我门钥匙」。2026-11-12 实测复现过——
  // 漏了这一条，SPA 的登录按钮永远回 401 `未登录：先打开 /login`。
  '/api/login',
  // 退出同理：会话已经过期时点「退出」，正确行为是「照样成功」，而不是弹一个 401。
  '/api/logout',
]);

/**
 * 这个路径要不要凭据。
 *
 * 只有 `/api/*` 和 `/v1/*` 要。其余（`/`、`/accounts`、`/login`、`/assets/*`）都是
 * 前端产物——**未登录时也要能拿到**，否则登录页自己就加载不出来。
 */
function needsAuth(path: string): boolean {
  return path.startsWith('/api/') || path.startsWith('/v1/');
}

export const authGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!needsAuth(c.req.path) || PUBLIC_PATHS.has(c.req.path)) return next();

  // 两类凭据：程序带 API key（Bearer），浏览器带会话 Cookie。任一通过即放行。
  // **没有第三种**——v1 的明文 token 和 Basic 都删了（见 private/docs/v2 §5）。
  const bearer = extractBearer(c.req.header('authorization'));
  const authorized =
    (bearer !== null && verifyKey(bearer) !== null) ||
    sessionValid(sessionFromCookie(c.req.header('cookie')));
  if (!authorized) {
    // 一律 JSON：前端拿到 401 会自己跳登录页（`api/client.ts` 的 `setNavigator`），
    // 不需要服务端 302。旧版对「像页面」的路径 302，那是 SSR 时代的产物。
    return c.json(
      { error: { message: '未登录：先打开 /login，或在 Authorization 里带 Bearer key', type: 'unauthorized' } },
      401,
    );
  }

  return next();
};

/**
 * `/v1/*` 只认 Bearer key，**不认会话 Cookie**。
 *
 * `authGate` 是通配的（先 Bearer 再 Cookie），所以浏览器里登录过的人在地址栏敲
 * `/v1/models` 也能拿到数据。菜单面上没洞，但边界必须能被代码表达。
 *
 * 真正的理由：`/v1/*` 是给程序和脚本用的协议入口，凭据模型是一把可单独吊销的 key。
 * 允许 Cookie 会让跨站请求自动带上凭据（`SameSite=Lax` 挡不住顶层 GET 导航），
 * 而容器部署时 `Host` 闸是关的——Cookie 就是唯一还在挡的东西。
 *
 * `/api/*` 不受影响，它照旧两种都认（浏览器要用 Cookie 开管理台）。
 */
export const bearerOnlyGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const bearer = extractBearer(c.req.header('authorization'));
  if (bearer === null || verifyKey(bearer) === null) {
    return c.json(
      {
        error: {
          message: '/v1/* 只认 API key：在 Authorization 里带 Bearer sk-…（在 /keys 页建一把）',
          type: 'unauthorized',
        },
      },
      401,
    );
  }
  return next();
};

export const passwordGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const path = c.req.path;

  // 前端产物不受改密闸影响（它们没有数据）。只看 API。
  if (!mustChangePassword() || !needsAuth(path) || PUBLIC_PATHS.has(path)) return next();

  // **`/api/password` 必须豁免**，否则全新部署直接死锁：SPA 用 JSON 端点改密，
  // 而它本身在 `/api/*` 下、会被下面那个 403 拦住 —— 新部署的网关于是**永远改不了密**。
  // 2026-11-12 起服务实测复现（改密回 403 password_change_required）。
  // 这条豁免是安全的：改密本身要求 `current` 密码正确，且它在 authGate 后面。
  if (path === '/api/password') return next();

  return c.json(
    {
      error: {
        message: '还没改过默认密码：先打开 /password 设置新密码，之后再访问接口',
        type: 'password_change_required',
      },
    },
    403,
  );
};
