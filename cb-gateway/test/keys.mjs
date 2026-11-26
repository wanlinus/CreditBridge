// 守护 API key：生成、哈希存储、校验、快照缓存、停用、删除。跑在临时目录，不碰真实库。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, section, done } from './_helpers.mjs';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-keys-'));
process.env.QB_DATA_DIR = tempData;

const keys = await import('../src/core/keys.ts');
const { db, closeDb } = await import('../src/shared/db.ts');
const keyRows = () => db.prepare('SELECT * FROM api_key ORDER BY created_at').all();

try {
  section('1. 空表');
  check('全新部署零 key', keys.listKeys(), []);
  check('也没有旧 token', keys.hasAnyCredential(), false);

  section('2. 新建');
  const first = keys.createKey('DSH 笔记本');
  check('secret 是 sk- 前缀', first.secret.startsWith('sk-'));
  check('secret 长度 51', first.secret.length, 51);
  check('主体只含字母数字', /^[A-Za-z0-9]{48}$/u.test(first.secret.slice(3)));
  check('prefix 是前 12 个字符', first.record.prefix, first.secret.slice(0, 12));
  check('label 用传进来的', first.record.label, 'DSH 笔记本');
  check('默认启用', first.record.enabled, true);
  check('accountScope 默认 null', first.record.accountScope, null);
  check('id 是 k_ 前缀', /^k_[0-9a-f]{8}$/u.test(first.record.id));

  // 视图不带敏感字段；明文只能从 createKey 的返回值拿到（唯一出口）
  const view = keys.listKeys()[0];
  check('列表里没有 hash', 'hash' in view, false);
  check('列表里没有 salt', 'salt' in view, false);
  check('列表里没有明文', 'secret' in view, false);
  check('createKey 返回了明文', first.secret.length, 51);

  const stored = keyRows()[0];
  check('库里没有 secret 列（v2 迁移已删）', 'secret' in stored, false);
  check('库里记了前缀', stored.prefix, first.record.prefix);
  check('库里有 salt 和 hash', /^[0-9a-f]{32}$/u.test(stored.salt) && /^[0-9a-f]{64}$/u.test(stored.hash));
  check('enabled 存成 0/1 而不是布尔', stored.enabled, 1);
  check('有 key 之后 hasAnyCredential 为真', keys.hasAnyCredential());

  section('3. 校验');
  check('正确的 secret 通过', keys.verifyKey(first.secret)?.id, first.record.id);
  // 换掉最后一个字符，且必须挑和原来不同的：直接写 'x' 在原字符正好是 x 时就是原串，
  // 测试会随机红一次（2026-11-13 撞过）
  const lastChar = first.secret.at(-1);
  const forgedChar = lastChar === 'x' ? 'y' : 'x';
  const rejectCases = [
    ['错一个字符被拒', `${first.secret.slice(0, -1)}${forgedChar}`],
    ['截断被拒', first.secret.slice(0, 20)],
    ['别的前缀被拒（旧 token 不走这条路）', 'a'.repeat(64)],
    ['空值被拒', ''],
    ['非字符串被拒', 123],
  ];
  for (const [name, input] of rejectCases) check(name, keys.verifyKey(input), null);

  section('4. 多把 key 独立');
  const second = keys.createKey('脚本');
  check('两把 key 的 prefix 不同', first.record.prefix !== second.record.prefix);
  check('第一把仍能过', keys.verifyKey(first.secret)?.id, first.record.id);
  check('第二把能过', keys.verifyKey(second.secret)?.id, second.record.id);
  check('列表按创建时间排序', keys.listKeys().map((k) => k.label), ['DSH 笔记本', '脚本']);
  check('前缀相同但内容不同被拒', keys.verifyKey(first.record.prefix + 'x'.repeat(48)), null);
  check('用过之后有 lastUsedAt', typeof keys.listKeys()[0].lastUsedAt, 'number');

  section('5. 停用 / 启用 / 改名 / 删除');
  check('停用', keys.updateKey(first.record.id, { enabled: false }).enabled, false);
  check('停用后立刻失效（缓存也要清）', keys.verifyKey(first.secret), null);
  check('停用不影响另一把', keys.verifyKey(second.secret)?.id, second.record.id);
  check('重新启用', keys.updateKey(first.record.id, { enabled: true }).enabled, true);
  check('启用后又能用', keys.verifyKey(first.secret)?.id, first.record.id);

  check('改名', keys.updateKey(first.record.id, { label: '  笔记本  ' }).label, '笔记本');
  check('空名字不生效', keys.updateKey(first.record.id, { label: '   ' }).label, '笔记本');
  check('改不存在的 key 返回 undefined', keys.updateKey('k_deadbeef', { label: 'x' }) === undefined);

  check('删除第二把', keys.deleteKey(second.record.id), true);
  check('删掉之后校验不过', keys.verifyKey(second.secret), null);
  check('删掉之后不在列表里', keys.listKeys().map((k) => k.id), [first.record.id]);
  check('删不存在的返回 false', keys.deleteKey(second.record.id), false);

  section('6. 重启后仍能校验');
  keys.resetKeysForTests();
  check('重启后仍能校验', keys.verifyKey(first.secret)?.id, first.record.id);
  check('重启后列表还在', keys.listKeys().length, 1);

  section('7. 快照缓存（跳过 scrypt 的直接证据）');
  // 快照价值在「跳过 scrypt」：命中快照不该再查库。用「删库行后仍能校验」证明它真被用上
  keys.resetKeysForTests();
  check('快照清空后先校验一次（填充快照）', keys.verifyKey(first.secret)?.id, first.record.id);

  const savedRow = { ...keyRows()[0] };
  db.prepare('DELETE FROM api_key').run();
  check('库里的行已删掉', keyRows().length, 0);
  check('删了库行仍能校验（快照命中，没查库）', keys.verifyKey(first.secret)?.id, first.record.id);

  keys.resetKeysForTests();
  check('清空快照后查库查不到', keys.verifyKey(first.secret), null);

  db.prepare(
    `INSERT INTO api_key (id, label, salt, hash, prefix, created_at, last_used_at, enabled, account_scope)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(savedRow.id, savedRow.label, savedRow.salt, savedRow.hash, savedRow.prefix, savedRow.created_at, null, 1, null);
  check('恢复后又能校验', keys.verifyKey(first.secret)?.id, first.record.id);

  section('8. 快照 TTL 可配置');
  check('默认 TTL 是 1 天', keys.keySnapshotTtl(), 86_400_000);
  check('设置成 2 天', keys.setKeySnapshotTtl(2 * 86_400_000), 2 * 86_400_000);
  check('设回 null 恢复默认', keys.setKeySnapshotTtl(null), 86_400_000);
  // 小于 1 分钟的值必须被忽略，否则用户填 0 就等于永远不刷新
  const smallTtl = [[10], [-1]];
  for (const [v] of smallTtl) {
    keys.setKeySnapshotTtl(v);
    check(`过小/负的 TTL 被忽略（${v}）`, keys.keySnapshotTtl(), 86_400_000);
  }
} finally {
  closeDb();
  fs.rmSync(tempData, { recursive: true, force: true });
}
done();
