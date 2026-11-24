// 网关唯一的 SQLite 连接。
//
// ## 这里只做三件事
//
// ① 拿到连接；② 设 PRAGMA；③ 按 `user_version` 建表/升级。别的一概不做——
// 不开连接池（`DatabaseSync` 就是一个句柄，网关是单进程单用户，并发就是 Node 的
// 事件循环，多开连接只会引入 `SQLITE_BUSY`）、不导出 `query()` 泛型助手（
// `db.prepare(sql).get()` 已经够短，多一层只是把 SQL 挪得离调用点更远）。
//
// ## SQL 不许外流
//
// **`db.prepare` 只允许出现在 `src/store/*.ts` 和本文件。** 这条是可执行的
// （`Select-String -Path src/**/*.ts -Pattern 'db\.prepare'`），不是口头约定。
// 理由见 private/docs/v4/README.md §5.1：抽象的形状决定调用方行为——给个 `findAll()`，
// 早晚有人把 60 万行账本拉进内存。
//
// ## 为什么用 `node:sqlite`
//
// Node 22.18+ 内置，零依赖、同步 API，正好接住现有那些同步调用点（`fs.*Sync`）。
// 代价是 `package.json` 的 engines 必须 ≥22.18，已经在要求里了。
//
// ## 踩过的坑（都是实测）
//
// - **布尔值不能直接当参数绑**：`stmt.run(true)` 抛
//   `Provided value cannot be bound to SQLite parameter`。写库前必须 `? 1 : 0`，
//   读出来再 `=== 1`。SQLite 没有 boolean 类型。
// - **`undefined` 也不能绑**，要显式写 `null`。
// - **`db.transaction()` 不存在**（`typeof` 是 `undefined`），要事务就手写
//   `BEGIN` / `COMMIT` / `ROLLBACK`，并且必须 `try/finally`——中途抛错留下一个开着
//   的事务，下一个请求看到的是脏状态。
// - **`readOnly: true` 要真布尔**，传 `1` 会被当成「不是 false」而报错。
// - **只拷 `gateway.db` 备份会丢数据**：WAL 模式下未 checkpoint 的行在 `-wal` 里。
//   备份要连 `-wal` / `-shm` 一起，或者先 `PRAGMA wal_checkpoint(TRUNCATE)`。

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { DATA_DIR } from './paths.ts';

const DB_PATH = path.join(DATA_DIR, 'gateway.db');

// `data/` 可能整个被删掉（AGENTS.md 允许这么做），打开之前要补回来。
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);

// **顺序有意义**：WAL 要在建表之前设。`synchronous = NORMAL` 是 WAL 下的常用档位——
// 崩溃不丢已提交事务，又不用每条都 fsync。`foreign_keys` 默认是关的，不显式打开
// `ON DELETE CASCADE` 就是死约束（实测：关着时删账号不会连带删签到状态）。
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA foreign_keys = ON');

/** 当前 schema 版本。加表/改列时 +1，并在 `MIGRATIONS` 里追加一段。 */
const SCHEMA_VERSION = 3;

/**
 * 按版本顺序排列的迁移。数组下标 = 从哪个版本升上来的。
 *
 * **不加 `IF NOT EXISTS`**：靠 `user_version` 判断该不该跑，加了自己会掩盖「版本号
 * 和实际结构不一致」这件事。不做 down migration——单机单用户，回滚就是删库重来。
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE usage_record (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                 INTEGER NOT NULL,
    provider           TEXT    NOT NULL,
    account            TEXT,
    model              TEXT,
    effort             TEXT,
    credit             REAL,
    prompt_tokens      INTEGER,
    completion_tokens  INTEGER,
    reasoning_tokens   INTEGER,
    total_tokens       INTEGER,
    cached_tokens      INTEGER,
    cache_write_tokens INTEGER,
    duration_ms        INTEGER,
    status             INTEGER
  );
  CREATE INDEX idx_usage_ts          ON usage_record(ts);
  CREATE INDEX idx_usage_account_ts  ON usage_record(account, ts);
  CREATE INDEX idx_usage_provider_ts ON usage_record(provider, ts);

  CREATE TABLE account (
    id             TEXT PRIMARY KEY,
    channel_id     TEXT    NOT NULL,
    seq            INTEGER NOT NULL,
    label          TEXT    NOT NULL,
    credential     TEXT,
    status         TEXT    NOT NULL,
    cooldown_until INTEGER,
    status_message TEXT,
    profile        TEXT,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    UNIQUE(channel_id, seq)
  );

  CREATE TABLE account_seq (
    channel_id TEXT PRIMARY KEY,
    seq        INTEGER NOT NULL
  );

  CREATE TABLE api_key (
    id            TEXT PRIMARY KEY,
    label         TEXT,
    secret        TEXT,
    salt          TEXT,
    hash          TEXT,
    prefix        TEXT,
    created_at    INTEGER,
    last_used_at  INTEGER,
    enabled       INTEGER NOT NULL DEFAULT 1,
    account_scope TEXT
  );

  CREATE TABLE gateway_credential (
    id                   INTEGER PRIMARY KEY CHECK (id = 1),
    username             TEXT    NOT NULL,
    salt                 TEXT    NOT NULL,
    hash                 TEXT    NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE checkin_state (
    account TEXT PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
    state   TEXT NOT NULL
  );

  CREATE TABLE checkin_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    account     TEXT    NOT NULL,
    channel     TEXT    NOT NULL,
    status      TEXT    NOT NULL,
    credits     REAL,
    streak_days INTEGER,
    message     TEXT,
    source      TEXT    NOT NULL
  );
  CREATE INDEX idx_checkin_log_ts ON checkin_log(ts);

  CREATE TABLE model_setting (
    channel_prefix   TEXT NOT NULL,
    model_id         TEXT NOT NULL,
    context_window   INTEGER,
    max_tokens       INTEGER,
    reasoning_effort TEXT,
    PRIMARY KEY (channel_prefix, model_id)
  );

  CREATE TABLE channel_visibility (
    channel_prefix TEXT PRIMARY KEY,
    listed         INTEGER NOT NULL DEFAULT 1,
    models         TEXT
  );
  `,

  /**
   * v2：`api_key` 去掉 `secret` 列（明文不再落库）。
   *
   * ## 为什么重建表而不是 `ALTER TABLE DROP COLUMN`
   *
   * SQLite 的 `DROP COLUMN` 从 3.35 才有，而且对「有索引/视图引用」的列有限制。
   * 重建表（CREATE → INSERT → DROP → RENAME）是**所有版本都稳**的做法，
   * 也是官方推荐的 alter 方法。
   *
   * ## 老 key 不会失效
   *
   * 只搬 `salt` / `hash` / `prefix` 等列，**校验靠 hash+salt 照常工作**。
   * 实测生产两个 key 的 salt（32 字节）和 hash（64 字节）都在。
   *
   * ## 为什么必须先 `UPDATE ... SET secret = NULL`
   *
   * 重建时只 `INSERT` 需要的列，`secret` 根本不会进新表——所以这步其实不必，
   * 但**保留它作为显式声明**：告诉后来读代码的人「这一列是有意丢弃的」，
   * 而不是漏拷了。值为 NULL 时不产生任何写入开销。
   */
  `
  UPDATE api_key SET secret = NULL;

  CREATE TABLE api_key_new (
    id            TEXT PRIMARY KEY,
    label         TEXT,
    salt          TEXT,
    hash          TEXT,
    prefix        TEXT,
    created_at    INTEGER,
    last_used_at  INTEGER,
    enabled       INTEGER NOT NULL DEFAULT 1,
    account_scope TEXT
  );

  INSERT INTO api_key_new (id, label, salt, hash, prefix, created_at, last_used_at, enabled, account_scope)
    SELECT id, label, salt, hash, prefix, created_at, last_used_at, enabled, account_scope FROM api_key;

  DROP TABLE api_key;
  ALTER TABLE api_key_new RENAME TO api_key;

  CREATE INDEX idx_api_key_prefix ON api_key(prefix);
  `,

  // v3：账号级签到开关。加列而不是塞进 `profile` JSON——那个每次登录都重写，会丢。
  `
  ALTER TABLE account ADD COLUMN checkin_enabled INTEGER NOT NULL DEFAULT 1;
  `,
];

function currentVersion(): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return Number(row?.user_version) || 0;
}

function migrate(): void {
  const from = currentVersion();
  if (from >= SCHEMA_VERSION) return;
  for (let version = from; version < SCHEMA_VERSION; version += 1) {
    // 一个版本的建表语句包在一个事务里：中途失败就整体回退，不会留下「跑了一半的
    // schema」——那种状态最坏，因为它看起来能用。
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

migrate();

/**
 * 关掉连接。
 *
 * **只给测试用**：Windows 上删不掉一个被打开的文件，而测试跑完会 `rmSync` 自己的
 * 临时目录（`QB_DATA_DIR` 就在里面），库文件还开着就会拿到 `EPERM`。生产代码不需要
 * 关连接——进程退出时内核自会释放，手动关只会引入「关早了，后续查询全崩」的风险。
 */
export function closeDb(): void {
  db.close();
}
