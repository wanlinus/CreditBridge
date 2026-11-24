/**
 * 网关自述状态与登录/改密/退出接口。
 *
 * 这几个都在 `/api/*` 下。**服务端不再有表单版**（`POST /login`、`GET /logout` 那套
 * 随 SSR 页面一起删掉了），所以这里就是唯一的入口。
 */
import { api, request } from './client';

/** `GET /api/health` 的形状。只抄骨架用到的字段，其余按需补（§13 讨论漂移风险）。 */
export interface Health {
  ok: boolean;
  gateway: string;
  version: string;
  startedAt: string;
  /** 每天签到时间点（`HH:MM`）。v3 加进 `/api/health` 的字段。 */
  checkinTime: string;
  /**
   * API key 校验快照的 TTL（毫秒）。
   *
   * 快照在内存里，键是 `sha256(secret)`：命中就直接放行、跳过 scrypt（单次 61ms）。
   * TTL 决定「进程外改库」多久被发现——手动改库的概率很小，所以默认 1 天。
   */
  keysSnapshotTtlMs: number;
  modelIdFormat: string;
  /** 以**通道 id**（`workbuddy`）为键，不是 idPrefix（`wb`）。 */
  channels: Record<string, HealthChannel>;
  accounts: HealthAccount[];
}

interface HealthChannel {
  id: string;
  label: string;
  idPrefix: string;
  identity: Record<string, string>;
  listed: boolean;
  multiAccount: boolean;
  canLogin: boolean;
  canLogout: boolean;
  canRotateDevice: boolean;
  canVerify: boolean;
  accounts: string[];
}

interface HealthAccount {
  id: string;
  channelId: string;
  channelLabel: string;
  idPrefix: string;
  label: string;
  status: string;
  statusMessage: string | null;
  cooldownUntil: number | null;
  uid: string | null;
  username: string | null;
  hasCredential: boolean;
  createdAt: number;
}

export function getHealth(): Promise<Health> {
  return api.get<Health>('/api/health');
}

/**
 * JSON 登录。
 *
 * `skipAuthRedirect`：登录失败是 401，但**不能**因此跳登录页——我们已经在登录页上，
 * 跳转会让「密码错了」的提示瞬间消失。
 */
export async function login(username: string, password: string): Promise<{ ok: boolean; mustChangePassword: boolean }> {
  return request('/api/login', {
    method: 'POST',
    body: { username, password },
    skipAuthRedirect: true,
  });
}

/**
 * 改密。
 *
 * 同样是 `skipAuthRedirect`：未改密时这个端点是唯一能用的写入口（`passwordGate` 豁免了
 * 它），走到这里说明用户已经在改密页，不该再跳一次。
 */
export async function changePassword(current: string, next: string, confirm: string): Promise<{ ok: boolean }> {
  return request('/api/password', {
    method: 'POST',
    body: { current, next, confirm },
    skipAuthRedirect: true,
  });
}

/**
 * 退出登录。
 *
 * 旧版是 `GET /logout`（服务端清 Cookie 后 302 到登录页）。SPA 里那个 302 没意义——
 * 前端的路由才是「去哪一页」的决定者。现在是 `POST /api/logout` + 前端 `router.push`。
 *
 * **幂等**：会话早就过期时也回 200，前端照常跳登录页。
 */
export function logout(): Promise<{ ok: boolean; removed: boolean }> {
  return request('/api/logout', { method: 'POST', skipAuthRedirect: true });
}

/**
 * 改配置：签到时间点、API key 快照 TTL。
 *
 * `checkinTime` 是 `HH:MM`（24 小时制），进 `config.json`；
 * `keysSnapshotTtlMs` 只在内存里（重启回默认 1 天），不进文件。
 *
 * 服务端有白名单校验，非法值回 400 + 人话原因，所以这里不重复校验一遍。
 */
export function updateConfig(patch: {
  checkinTime?: string;
  keysSnapshotTtlMs?: number;
}): Promise<{ ok: true; checkinTime: string; keysSnapshotTtlMs: number }> {
  return request('/api/config', { method: 'PATCH', body: patch });
}
