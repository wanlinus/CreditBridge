import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.QB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-gw-icons-'));

const { channels } = await import('../src/channels/index.ts');
const { iconOf, letterOf, resetChannelIconCacheForTests } = await import('../src/core/channel-icons.ts');

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}\n      期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}
function checkTrue(name, actual) {
  if (actual) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}`);
  }
}

const PNG_PREFIX = 'data:image/png;base64,';

function pngInfo(uri) {
  const bytes = Buffer.from(uri.slice(PNG_PREFIX.length), 'base64');
  const signature = [...bytes.subarray(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return {
    signature,
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    size: bytes.length,
  };
}

console.log('--- 1. 每个通道都有图标 ---');
for (const channel of channels) {
  const uri = iconOf(channel.id);
  checkTrue(`${channel.id} 有图标`, typeof uri === 'string' && uri.startsWith(PNG_PREFIX));
  if (typeof uri !== 'string' || !uri.startsWith(PNG_PREFIX)) continue;
  const info = pngInfo(uri);
  check(`${channel.id} 是合法 PNG`, info.signature, '89504e470d0a1a0a');
  check(`${channel.id} 是 64×64`, [info.width, info.height], [64, 64]);
}

console.log('\n--- 2. 缺失与非法 id 返回 null ---');
check('不存在的通道返回 null', iconOf('nosuchchannel'), null);
check('带路径穿越的字符返回 null', iconOf('../etc/passwd'), null);
check('大写字母不在白名单里', iconOf('Workbuddy'), null);
check('空串返回 null', iconOf(''), null);

console.log('\n--- 3. 缓存 ---');
const first = iconOf('loomy');
const second = iconOf('loomy');
checkTrue('两次调用返回同一个字符串实例（说明走了缓存）', first === second);
resetChannelIconCacheForTests();
checkTrue('清缓存后仍能读出来', typeof iconOf('loomy') === 'string');

console.log('\n--- 4. 兜底字母 ---');
check('取 label 首字母并大写', letterOf({ id: 'loomy', label: 'loomy' }), 'L');
check('label 为空时退回 id', letterOf({ id: 'werk', label: '' }), 'W');
check('中文 label 不炸', letterOf({ id: 'x', label: '测试通道' }), '测');

console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail} 项失败`);
assert.equal(fail, 0);
