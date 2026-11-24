// API key：生成、哈希存储、校验、停用、删除、最后使用时间。
//
// 跑在临时目录里（QB_DATA_DIR），不碰真实 keys.json。
//
// 跑：node test/keys.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-keys-'));
process.env.QB_DATA_DIR = tempData;

const keys = await import('../src/core/keys.ts');

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

// v4 起 key 进库（`api_key` 表），不再有 `auth/keys.json`。断言改成查库。
const { db, closeDb } = await import('../src/shared/db.ts');
const keyRows = () => db.prepare('SELECT * FROM api_key ORDER BY created_at').all();

try {
  // ---- 1. 空表 ----
  check('全新部署零 key', keys.listKeys(), []);
  check('也没有旧 token', keys.hasAnyCredential(), false);

  // ---- 2. 新建 ----
  const first = keys.createKey('DSH 笔记本');
  check('secret 是 sk- 前缀（和 OpenAI 同形）', first.secret.startsWith('sk-'), true);
  check('secret 长度 51（sk- + 48 位字母数字）', first.secret.length, 51);
  check('主体只含字母数字', /^[A-Za-z0-9]{48}$/u.test(first.secret.slice(3)), true);
  check('prefix 是前 12 个字符', first.record.prefix, first.secret.slice(0, 12));
  check('label 用传进来的', first.record.label, 'DSH 笔记本');
  check('默认启用', first.record.enabled, true);
  check('accountScope 默认 null', first.record.accountScope, null);
  check('id 是 k_ 前缀', /^k_[0-9a-f]{8}$/u.test(first.record.id), true);

  // 视图里不能带敏感字段（salt/hash 是内部实现，不对外）。
  check('列表里没有 hash', 'hash' in keys.listKeys()[0], false);
  check('列表里没有 salt', 'salt' in keys.listKeys()[0], false);
  // **明文必须取不回来**（2026-11-22 起）：库里只存 scrypt 材料，列表接口不返回 secret。
  // 换成「建完还能再看原文」代价是库泄露 = key 泄露，不值。
  check('列表里没有明文', 'secret' in keys.listKeys()[0], false);
  check('列表里的 secret 是 undefined', keys.listKeys()[0].secret === undefined, true);

  // 库里也不能有明文——`secret` 列已在 v2 迁移里物理删除。
  const stored = keyRows()[0];
  check('库里没有 secret 列（v2 迁移已删）', 'secret' in stored, false);
  check('库里记了前缀（给页面识别用）', stored.prefix, first.record.prefix);
  check('库里有 salt 和 hash（唯一校验材料）', /^[0-9a-f]{32}$/u.test(stored.salt) && /^[0-9a-f]{64}$/u.test(stored.hash));
  check('enabled 存成 0/1 而不是布尔', stored.enabled, 1);
  check('有 key 之后 hasAnyCredential 为真', keys.hasAnyCredential(), true);

  // 明文只能从 createKey 的返回值拿到。这条钉住「唯一出口」——将来谁想加
  // 「查看原文」的接口，会先撞到它。
  check('createKey 返回了明文', first.secret.length, 51);

  // ---- 3. 校验 ----
  check('正确的 secret 通过', keys.verifyKey(first.secret)?.id, first.record.id);
  // 换掉最后一个字符。**必须挑一个和原来不同的**：直接写 `slice(0,-1) + 'x'` 在
  // 原字符正好是 `x` 时就是原串（62 分之 1 的概率），测试会随机红一次——
  // 2026-11-13 全量跑时撞上过一次，查了半天才发现是测试自己的锅。
  const lastChar = first.secret.at(-1);
  const forgedChar = lastChar === 'x' ? 'y' : 'x';
  check('错一个字符被拒', keys.verifyKey(`${first.secret.slice(0, -1)}${forgedChar}`), null);
  check('截断被拒', keys.verifyKey(first.secret.slice(0, 20)), null);
  check('别的前缀被拒（旧 token 不走这条路）', keys.verifyKey('a'.repeat(64)), null);
  check('空值被拒', keys.verifyKey(''), null);
  check('非字符串被拒', keys.verifyKey(123), null);

  // 第二把 key 独立：各自的 secret 只认自己。
  const second = keys.createKey('脚本');
  check('两把 key 的 prefix 不同', first.record.prefix !== second.record.prefix, true);
  check('第一把仍能过', keys.verifyKey(first.secret)?.id, first.record.id);
  check('第二把能过', keys.verifyKey(second.secret)?.id, second.record.id);
  check('列表按创建时间排序', keys.listKeys().map((k) => k.label), ['DSH 笔记本', '脚本']);

  // 同一前缀、内容不同（理论上撞车）：仍然只认完全相等的那串。
  const forged = first.record.prefix + 'x'.repeat(first.secret.length - first.record.prefix.length);
  check('前缀相同但内容不同被拒', keys.verifyKey(forged), null);

  // ---- 4. 最后使用时间 ----
  check('用过之后有 lastUsedAt', typeof keys.listKeys()[0].lastUsedAt, 'number');

  // ---- 5. 停用 / 启用 ----
  check('停用', keys.updateKey(first.record.id, { enabled: false }).enabled, false);
  check('停用后立刻失效（缓存也要清）', keys.verifyKey(first.secret), null);
  check('停用不影响另一把', keys.verifyKey(second.secret)?.id, second.record.id);
  check('重新启用', keys.updateKey(first.record.id, { enabled: true }).enabled, true);
  check('启用后又能用', keys.verifyKey(first.secret)?.id, first.record.id);

  // ---- 6. 改名 ----
  check('改名', keys.updateKey(first.record.id, { label: '  笔记本  ' }).label, '笔记本');
  check('空名字不生效', keys.updateKey(first.record.id, { label: '   ' }).label, '笔记本');
  check('改不存在的 key 返回 undefined', keys.updateKey('k_deadbeef', { label: 'x' }) === undefined);

  // ---- 7. 删除 ----
  check('删除第二把', keys.deleteKey(second.record.id), true);
  check('删掉之后校验不过', keys.verifyKey(second.secret), null);
  check('删掉之后不在列表里', keys.listKeys().map((k) => k.id), [first.record.id]);
  check('删不存在的返回 false', keys.deleteKey(second.record.id), false);

  // ---- 8. 重启（丢掉内存里的校验缓存）----
  keys.resetKeysForTests();
  check('重启后仍能校验', keys.verifyKey(first.secret)?.id, first.record.id);
  check('重启后列表还在', keys.listKeys().length, 1);

  // ---- 8b. 内存快照（2026-11-22）----
  //
  // 快照的价值在「跳过 scrypt」：单次 61ms，而查库 0.03ms。所以命中快照时
  // 不该再去查库。这里用「把库里的行删掉、快照仍能校验通过」来证明它真的被用上了
  // ——如果每次都查库，删行之后必然失败。
  keys.resetKeysForTests();
  check('快照清空后先校验一次（填充快照）', keys.verifyKey(first.secret)?.id, first.record.id);

  // 删行前先把这一行存下来，等下要插回去
  const savedRow = { ...keyRows()[0] };
  const rowCountBefore = keyRows().length;
  db.prepare('DELETE FROM api_key').run();
  check('库里的行已删掉', keyRows().length, 0);

  // 快照里还有它 → 仍然通过。这条是快照生效的**直接证据**。
  check('删了库行仍能校验（快照命中，没查库）', keys.verifyKey(first.secret)?.id, first.record.id);

  // 手动改库（绕过网关）之后，TTL 到期才会重新读。用 TTL=1 分钟 + 伪造过期来验。
  keys.resetKeysForTests();
  check('清空快照后查库查不到', keys.verifyKey(first.secret), null);

  // 恢复一行，让后续断言能继续
  db.prepare(
    `INSERT INTO api_key (id, label, salt, hash, prefix, created_at, last_used_at, enabled, account_scope)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    savedRow.id,
    savedRow.label,
    savedRow.salt,
    savedRow.hash,
    savedRow.prefix,
    savedRow.created_at,
    null,
    1,
    null,
  );
  check('恢复后又能校验', keys.verifyKey(first.secret)?.id, first.record.id);

  // ---- 8c. TTL 可配置 ----
  check('默认 TTL 是 1 天', keys.keySnapshotTtl(), 86_400_000);
  check('设置成 2 天', keys.setKeySnapshotTtl(2 * 86_400_000), 2 * 86_400_000);
  check('设回 null 恢复默认', keys.setKeySnapshotTtl(null), 86_400_000);
  // 小于 1 分钟的值必须被忽略（否则用户填 0 就等于永远不刷新）
  keys.setKeySnapshotTtl(10);
  check('过小的 TTL 被忽略，仍是默认', keys.keySnapshotTtl(), 86_400_000);
  keys.setKeySnapshotTtl(-1);
  check('负数 TTL 被忽略', keys.keySnapshotTtl(), 86_400_000);

  // ---- 9. 「文件坏了当空表」这一组已经删掉 ----
  //
  // 进库之前这里塞了半截 JSON，验证「坏文件当空表、不抛异常」。SQLite 给不出半行：
  // 要么整行在、要么在事务回滚后不在。留着这条只会让人以为还有一条「坏文件」的
  // 降级路径要维护。写时原子性由事务保证，见 `shared/db.ts`。
} finally {
  // 先关库再删临时目录：Windows 上删不掉一个被打开的文件（EPERM）。
  closeDb();
  fs.rmSync(tempData, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? `全部通过（${pass} 项）` : `${fail}/${pass + fail} 项失败`}`);
process.exitCode = fail === 0 ? 0 : 1;
