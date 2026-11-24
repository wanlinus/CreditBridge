/**
 * API key（`/api/keys/*`）。
 *
 * 密钥是给程序用的票据，和浏览器会话是两套独立凭据：改密码不该让 DSH 掉线，吊销一把
 * key 也不该让浏览器退出登录。
 *
 * **明文只出现一次**：库里只有 `salt` + `hash`，所以 `createKey()` 的响应顶层带
 * `secret`（唯一一次），而 `ApiKey` 里没有这个字段。忘了复制的唯一补救是删掉重建。
 */
import { api } from './client';

export interface ApiKey {
  /** `k_xxxxxx`，稳定标识（日志里出现的也是它）。 */
  id: string;
  label: string;
  /** `sk-` + 9 位，列表里用来区分哪把是哪把。**完整明文不在这里**。 */
  prefix: string;
  createdAt: number;
  /** 最后一次被用于认证的时间；`null` 表示建完从没用过。 */
  lastUsedAt: number | null;
  enabled: boolean;
  /** 限定这把 key 只能访问哪些账号；`null` = 不限制。目前界面不消费，但后端每条都回。 */
  accountScope: string[] | null;
}

export function getKeys(): Promise<{ keys: ApiKey[] }> {
  return api.get<{ keys: ApiKey[] }>('/api/keys');
}

/**
 * 新建。**明文只在这一次响应里出现**——之后任何接口都取不回来。
 *
 * 调用方必须当场展示给用户（`KeysView` 用一个只存在内存的 `fresh` 做这件事），
 * 用户没记下来就只能重建。
 */
export function createKey(label: string): Promise<{ key: ApiKey; secret: string }> {
  return api.post<{ key: ApiKey; secret: string }>('/api/keys', { label });
}

export function updateKey(id: string, patch: { label?: string; enabled?: boolean }): Promise<{ ok: true; key: ApiKey }> {
  return api.patch<{ ok: true; key: ApiKey }>(`/api/keys/${encodeURIComponent(id)}`, patch);
}

export function deleteKey(id: string): Promise<{ ok: true; removed: string }> {
  return api.delete<{ ok: true; removed: string }>(`/api/keys/${encodeURIComponent(id)}`);
}
