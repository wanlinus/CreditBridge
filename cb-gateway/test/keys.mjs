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

const keysPath = path.join(tempData, 'auth', 'keys.json');
const readDoc = () => JSON.parse(fs.readFileSync(keysPath, 'utf8'));

try {
  check('全新部署零 key', keys.listKeys(), []);
  check('也没有旧 token', keys.hasAnyCredential(), false);

  const first = keys.createKey('DSH 笔记本');
  check('secret 是 sk- 前缀（和 OpenAI 同形）', first.secret.startsWith('sk-'), true);
  check('secret 长度 51（sk- + 48 位字母数字）', first.secret.length, 51);
  check('主体只含字母数字', /^[A-Za-z0-9]{48}$/u.test(first.secret.slice(3)), true);
  check('prefix 是前 12 个字符', first.record.prefix, first.secret.slice(0, 12));
  check('label 用传进来的', first.record.label, 'DSH 笔记本');
  check('默认启用', first.record.enabled, true);
  check('accountScope 默认 null', first.record.accountScope, null);
  check('id 是 k_ 前缀', /^k_[0-9a-f]{8}$/u.test(first.record.id), true);

  check('列表里没有 hash', 'hash' in keys.listKeys()[0], false);
  check('列表里没有 salt', 'salt' in keys.listKeys()[0], false);
  check('列表里能取回明文', keys.listKeys()[0].secret, first.secret);

  const onDisk = fs.readFileSync(keysPath, 'utf8');
  check('盘上存了明文 secret', onDisk.includes(first.secret), true);
  check('盘上记了前缀（给页面识别用）', readDoc().keys[0].prefix, first.record.prefix);
  check('盘上有 salt 和 hash（兼容老的校验路径）', /^[0-9a-f]{32}$/u.test(readDoc().keys[0].salt) && /^[0-9a-f]{64}$/u.test(readDoc().keys[0].hash));
  check('有 key 之后 hasAnyCredential 为真', keys.hasAnyCredential(), true);

  check('正确的 secret 通过', keys.verifyKey(first.secret)?.id, first.record.id);
  check('错一个字符被拒', keys.verifyKey(`${first.secret.slice(0, -1)}x`), null);
  check('截断被拒', keys.verifyKey(first.secret.slice(0, 20)), null);
  check('别的前缀被拒（旧 token 不走这条路）', keys.verifyKey('a'.repeat(64)), null);
  check('空值被拒', keys.verifyKey(''), null);
  check('非字符串被拒', keys.verifyKey(123), null);

  const second = keys.createKey('脚本');
  check('两把 key 的 prefix 不同', first.record.prefix !== second.record.prefix, true);
  check('第一把仍能过', keys.verifyKey(first.secret)?.id, first.record.id);
  check('第二把能过', keys.verifyKey(second.secret)?.id, second.record.id);
  check('列表按创建时间排序', keys.listKeys().map((k) => k.label), ['DSH 笔记本', '脚本']);

  const forged = first.record.prefix + 'x'.repeat(first.secret.length - first.record.prefix.length);
  check('前缀相同但内容不同被拒', keys.verifyKey(forged), null);

  check('用过之后有 lastUsedAt', typeof keys.listKeys()[0].lastUsedAt, 'number');

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

  keys.resetKeysForTests();
  check('重启后仍能校验', keys.verifyKey(first.secret)?.id, first.record.id);
  check('重启后列表还在', keys.listKeys().length, 1);

  fs.writeFileSync(keysPath, '{ 这不是 JSON', 'utf8');
  keys.resetKeysForTests();
  check('坏文件当空表', keys.listKeys(), []);
  check('坏文件时校验返回 null', keys.verifyKey(first.secret), null);
  check('坏文件之后仍可新建', keys.createKey('新的').record.label, '新的');

  check('坏文件之后仍可新建', keys.createKey('新的').record.label, '新的');
} finally {
  fs.rmSync(tempData, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? `全部通过（${pass} 项）` : `${fail}/${pass + fail} 项失败`}`);
process.exitCode = fail === 0 ? 0 : 1;
