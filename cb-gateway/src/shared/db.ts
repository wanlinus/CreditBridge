// 网关唯一的 SQLite 连接：拿连接、设 PRAGMA、按 `user_version` 建表升级，别的一概不做。
// **`db.prepare` 只允许出现在 `src/store/*.ts` 和本文件**（给个 `findAll()` 早晚有人把 60 万行账本拉进内存）。
//
// 实测坑（`node:sqlite`）：布尔值不能直接绑（`stmt.run(true)` 抛错，要 `? 1 : 0`，读出来再 `=== 1`）；
// `undefined` 也不能绑要显式写 `null`；`db.transaction()` 不存在，要手写 `BEGIN`/`COMMIT` 且必须
// `try/finally`；`readOnly: true` 要真布尔（传 `1` 报错）；只拷 `gateway.db` 备份会丢 `-wal` 里未 checkpoint 的行。

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { DATA_DIR } from './paths.ts';

const DB_PATH = path.join(DATA_DIR, 'gateway.db');

// `data/` 可能整个被删掉（AGENTS.md 允许这么做），打开之前要补回来。
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);

// **顺序有意义**：WAL 要在建表之前设。`foreign_keys` 默认是关的，不显式打开
// `ON DELETE CASCADE` 就是死约束（实测：关着时删账号不会连带删签到状态）。
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA foreign_keys = ON');

/** 当前 schema 版本。加表/改列时 +1，并在 `MIGRATIONS` 里追加一段。 */
const SCHEMA_VERSION = 3;

/** 按版本顺序排列的迁移，数组下标 = 从哪个版本升上来的。**不加 `IF NOT EXISTS`**：那会掩盖「版本号和实际结构不一致」；不做 down migration，回滚就是删库重来。 */
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

  // v2：`api_key` 去掉 `secret` 列（明文不再落库）。重建表而不是 `DROP COLUMN`——后者 SQLite 3.35 才有且对索引引用有限制；
  // 老 key 不会失效（校验靠 salt+hash）。第一句 `SET secret = NULL` 是显式声明「这一列有意丢弃」，不是漏拷。
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
    // 一个版本的建表语句包在一个事务里：中途失败整体回退，不会留下「跑了一半的 schema」——那种状态看起来能用。
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

/** 关掉连接。**只给测试用**：Windows 上删不掉被打开的文件，测试跑完 `rmSync` 临时目录会拿到 `EPERM`。生产不需要关，进程退出内核自会释放。 */
export function closeDb(): void {
  db.close();
}
