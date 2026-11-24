// 网关网页账号密码（`gateway_credential`，单行表）。**唯一允许出现 SQL 的地方之一**。
//
// 这里只负责「读一行、写一行」。**哈希、比对、会话全部留在 `shared/gateway-auth.ts`**：
// 那是策略，换存储不该动它。
//
// 单行由 `CHECK (id = 1)` 保证——不是靠调用方记得只写一次。少了那个约束，
// 「读哪一行」就变成第一个 `SELECT *` 的运气问题。

import { db } from '../shared/db.ts';

export interface GatewayCredential {
  username: string;
  /** scrypt 的盐，hex。 */
  salt: string;
  /** scrypt(password, salt, 64) 的 hex。 */
  hash: string;
  /** 首次登录后必须先改密码，否则除登录/改密外的路由一律拒绝。 */
  mustChangePassword: boolean;
}

/**
 * 读那份凭据；没有就返回 `null`（调用方据此建默认账号）。
 *
 * **不在这里建默认值**：默认账号是策略，属于 `gateway-auth.ts`。
 */
export function getCredential(): GatewayCredential | null {
  const row = db.prepare('SELECT username, salt, hash, must_change_password FROM gateway_credential WHERE id = 1').get() as any;
  if (!row) return null;
  if (typeof row.username !== 'string' || typeof row.salt !== 'string' || typeof row.hash !== 'string') return null;
  return {
    username: row.username,
    salt: row.salt,
    hash: row.hash,
    // SQLite 没有 boolean：存 0/1，读出来要转回真布尔。
    mustChangePassword: Number(row.must_change_password) === 1,
  };
}

/** 写入（覆盖那一行）。 */
export function putCredential(credential: GatewayCredential): void {
  db.prepare(
    `INSERT OR REPLACE INTO gateway_credential (id, username, salt, hash, must_change_password)
     VALUES (1, ?, ?, ?, ?)`,
  ).run(credential.username, credential.salt, credential.hash, credential.mustChangePassword ? 1 : 0);
}
