import type { MiddlewareHandler } from 'hono';

import type { AppEnv } from '../app.ts';
import { verifyKey } from '../core/keys.ts';
import { extractBearer, mustChangePassword, sessionFromCookie, sessionValid } from '../shared/gateway-auth.ts';

const PUBLIC_PATHS = new Set([
  '/api/login',
  '/api/logout',
]);

function needsAuth(path: string): boolean {
  return path.startsWith('/api/') || path.startsWith('/v1/');
}

export const authGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!needsAuth(c.req.path) || PUBLIC_PATHS.has(c.req.path)) return next();

  const bearer = extractBearer(c.req.header('authorization'));
  const authorized =
    (bearer !== null && verifyKey(bearer) !== null) ||
    sessionValid(sessionFromCookie(c.req.header('cookie')));
  if (!authorized) {
    return c.json(
      { error: { message: '未登录：先打开 /login，或在 Authorization 里带 Bearer key', type: 'unauthorized' } },
      401,
    );
  }

  return next();
};

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

  if (!mustChangePassword() || !needsAuth(path) || PUBLIC_PATHS.has(path)) return next();

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
