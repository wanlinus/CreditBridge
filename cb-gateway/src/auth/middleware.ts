// 认证中间件：三道闸顺序固定——认证 → 强制改密 →（`/v1/*` 上）只认 Bearer。**只作用于 `/api/*` 和 `/v1/*`**：
// 其余是前端静态产物，登录页在没有任何凭据时也要能加载，否则就是「想进门先给我门钥匙」。

import type { MiddlewareHandler } from 'hono';

import type { AppEnv } from '../app.ts';
import { verifyKey } from '../core/keys.ts';
import { extractBearer, mustChangePassword, sessionFromCookie, sessionValid } from '../shared/gateway-auth.ts';

const PUBLIC_PATHS = new Set([
  // 两者都必须在公开名单里：来登录的人按定义还没凭据，而会话已过期时点「退出」的正确行为是照样成功。
  // 2026-11-12 实测：漏了 `/api/login`，SPA 的登录按钮永远回 401 `未登录：先打开 /login`。
  '/api/login',
  '/api/logout',
]);

function needsAuth(path: string): boolean {
  return path.startsWith('/api/') || path.startsWith('/v1/');
}

export const authGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!needsAuth(c.req.path) || PUBLIC_PATHS.has(c.req.path)) return next();

  // 两类凭据：程序带 API key（Bearer），浏览器带会话 Cookie。任一通过即放行。**没有第三种**。
  const bearer = extractBearer(c.req.header('authorization'));
  const authorized =
    (bearer !== null && verifyKey(bearer) !== null) ||
    sessionValid(sessionFromCookie(c.req.header('cookie')));
  if (!authorized) {
    // 一律 JSON：前端拿到 401 会自己跳登录页，不需要服务端 302。
    return c.json(
      { error: { message: '未登录：先打开 /login，或在 Authorization 里带 Bearer key', type: 'unauthorized' } },
      401,
    );
  }

  return next();
};

/** `/v1/*` 只认 Bearer key，**不认会话 Cookie**。 */
export const bearerOnlyGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  // `authGate` 是通配的（先 Bearer 再 Cookie），浏览器里登录过的人敲 `/v1/models` 也能拿到数据。必须拦住：
  // 允许 Cookie 会让跨站请求自动带上凭据（`SameSite=Lax` 挡不住顶层 GET 导航），而容器部署时 `Host` 闸是关的。
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

  // 前端产物不受改密闸影响（它们没有数据），只看 API。
  if (!mustChangePassword() || !needsAuth(path) || PUBLIC_PATHS.has(path)) return next();

  // **`/api/password` 必须豁免**，否则全新部署直接死锁：SPA 用 JSON 端点改密，而它本身在 `/api/*` 下、会被下面那个 403 拦住（2026-11-12 实测）。
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
