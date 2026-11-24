// 验证 v2 迁移：把带 secret 的旧库迁到新结构，且老 key 仍然可用。
//
// 这是**唯一有数据风险**的改动（DROP TABLE + RENAME），所以单独验：
//   1. 造一个 v1 结构的库（带 secret 列），塞两行
//   2. 跑 db.ts 的迁移
//   3. 断言：secret 列没了、salt/hash 还在、user_version = 2
//   4. 用真实 secret 校验能过（证明数据搬对了）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-migrate-v2-'));
process.env.QB_DATA_DIR = sandbox;

// 先用 node:sqlite 直接建一个 v1 结构的库
const { DatabaseSync } = await import('node:sqlite');
const dbPath = path.join(sandbox, 'gateway.db');

const secret = 'sk-' + 'A'.repeat(48);
const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(secret, Buffer.from(salt, 'hex'), 32, { N: 16384, r: 8, p: 1 }).toString('hex');

{
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
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
    CREATE TABLE usage_record (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, provider TEXT NOT NULL,
      account TEXT, model TEXT, effort TEXT, credit REAL, prompt_tokens INTEGER,
      completion_tokens INTEGER, reasoning_tokens INTEGER, total_tokens INTEGER,
      cached_tokens INTEGER, cache_write_tokens INTEGER, duration_ms INTEGER, status INTEGER
    );
    CREATE TABLE account (
      id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, seq INTEGER NOT NULL, label TEXT NOT NULL,
      credential TEXT, status TEXT NOT NULL, cooldown_until INTEGER, status_message TEXT,
      profile TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(channel_id, seq)
    );
    CREATE TABLE account_seq (channel_id TEXT PRIMARY KEY, next_seq INTEGER NOT NULL);
    CREATE TABLE gateway_credential (
      id INTEGER PRIMARY KEY CHECK (id = 1), username TEXT NOT NULL, salt TEXT NOT NULL,
      hash TEXT NOT NULL, must_change INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL
    );
    CREATE TABLE checkin_state (
      account TEXT PRIMARY KEY, date TEXT NOT NULL, status TEXT NOT NULL, message TEXT, ts INTEGER NOT NULL
    );
    CREATE TABLE checkin_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, date TEXT NOT NULL,
      status TEXT NOT NULL, message TEXT, source TEXT, ts INTEGER NOT NULL
    );
    CREATE TABLE model_setting (
      channel_prefix TEXT NOT NULL, model_id TEXT NOT NULL, context_window INTEGER,
      max_tokens INTEGER, reasoning_effort TEXT, PRIMARY KEY (channel_prefix, model_id)
    );
    CREATE TABLE channel_visibility (
      channel_prefix TEXT PRIMARY KEY, listed INTEGER NOT NULL DEFAULT 1, models TEXT
    );
    PRAGMA user_version = 1;
  `);
  // 两行旧数据，都带明文 secret
  const insert = raw.prepare(
    'INSERT INTO api_key (id, label, secret, salt, hash, prefix, created_at, last_used_at, enabled, account_scope) VALUES (?,?,?,?,?,?,?,?,?,?)',
  );
  insert.run('k_aaaaaaaa', 'dsh', secret, salt, hash, secret.slice(0, 12), 1700000000000, null, 1, null);
  insert.run('k_bbbbbbbb', 'cam', 'sk-' + 'B'.repeat(48), crypto.randomBytes(16).toString('hex'),
    crypto.scryptSync('sk-' + 'B'.repeat(48), Buffer.from(salt, 'hex'), 32, { N: 16384, r: 8, p: 1 }).toString('hex'),
    ('sk-' + 'B'.repeat(48)).slice(0, 12), 1700000001000, null, 1, null);
  raw.close();
  console.log('已造好 v1 结构库，2 行带 secret');
}

// 现在加载 db.ts —— 它会在 import 时跑 migrate()
const { db, closeDb } = await import('../src/shared/db.ts');

let pass = 0;
let fail = 0;
function check(name, actual, expected = true) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}\n      期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

console.log('\n=== 迁移结果 ===');
const version = db.prepare('PRAGMA user_version').get();
// 只断言「至少跑到 2」：这一套验的是 v2 那次 `api_key` 重建，而 `SCHEMA_VERSION`
// 会随新迁移继续往上走（v3 加了签到开关的表和列）。写死等于每次加迁移都要来改这里，
// 而那种「改测试让它变绿」的动作会让人分不清是迁移真跑对了还是断言放宽了。
// 下面那些列和数据的断言才是真正的验收标准。
check('user_version 至少升到 2', Number(version.user_version) >= 2, true);

const cols = db.prepare('pragma table_info(api_key)').all().map((c) => c.name);
console.log('  新表列:', cols.join(', '));
check('secret 列已物理删除', cols.includes('secret'), false);
check('salt 列还在', cols.includes('salt'), true);
check('hash 列还在', cols.includes('hash'), true);

const rows = db.prepare('SELECT * FROM api_key ORDER BY created_at').all();
check('两行数据都搬过来了', rows.length, 2);
check('label 保留', rows[0].label, 'dsh');
check('salt 保留', rows[0].salt, salt);
check('hash 保留', rows[0].hash, hash);
check('prefix 保留', rows[0].prefix, secret.slice(0, 12));
check('created_at 保留', Number(rows[0].created_at), 1700000000000);

// 最关键：老 secret 用迁移后的数据还能校验通过
const keys = await import('../src/core/keys.ts');
console.log('\n=== 老 key 仍可用 ===');
check('迁移前的老 secret 校验通过', keys.verifyKey(secret)?.id, 'k_aaaaaaaa');
check('列表能读到两把', keys.listKeys().length, 2);
check('列表里没有明文', 'secret' in keys.listKeys()[0], false);

console.log('\n=== 索引 ===');
const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='api_key'").all().map((r) => r.name);
console.log('  索引:', idx.join(', '));
check('prefix 索引建上了', idx.includes('idx_api_key_prefix'));

console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
closeDb();
try {
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 });
} catch {
  /* Windows 偶尔删不掉，系统会回收 */
}
process.exitCode = fail === 0 ? 0 : 1;
