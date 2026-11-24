// 通道图标的加载回归测试。
//
// ## 为什么要测这个
//
// 图标以前内联在前端（cb-dsh 的一张常量表）里，加通道要改插件、重新打包，
// 而且**漏了不会报错**——Loomy 上线后徽标一直没有图标，就是那张表里少了一行；
// 注释还写着「缺了会退回名字首字母」，实际上什么都不显示。
//
// 现在图标跟着通道目录走（`src/channels/<id>/icon.png`），网关读成 data URI 交给
// 前端。这里钉住四件事：
//
//   1. **每个已注册通道都有图标**——加通道忘了放图会在这里红，而不是在用户脸上
//      表现为「徽标没有图标」；
//   2. 交出去的是合法 PNG data URI（解码后魔数和尺寸都对得上）；
//   3. 缺失 / 非法 id 返回 `null` 而不是抛错（图标是装饰，不该让接口挂掉）；
//   4. 缓存生效（同一 id 两次调用拿到同一个字符串实例）。
//
// 跑：node test/channel-icons.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 图标模块不碰 data/，但导入链会带进路径模块，指到临时目录更保险。
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

/** 从 data URI 解出 PNG，读 IHDR 里的宽高。 */
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

// ---- 1. 每个已注册通道都能拿到图标 ----
console.log('--- 1. 每个通道都有图标 ---');
for (const channel of channels) {
  const uri = iconOf(channel.id);
  checkTrue(`${channel.id} 有图标`, typeof uri === 'string' && uri.startsWith(PNG_PREFIX));
  if (typeof uri !== 'string' || !uri.startsWith(PNG_PREFIX)) continue;
  const info = pngInfo(uri);
  // PNG 文件头：89 50 4E 47 0D 0A 1A 0A
  check(`${channel.id} 是合法 PNG`, info.signature, '89504e470d0a1a0a');
  // 统一 64×64：徽标里按 14×14 显示，4 倍超采样在 2x/3x 屏上都够。
  check(`${channel.id} 是 64×64`, [info.width, info.height], [64, 64]);
}

// ---- 2. 缺失 / 非法 id 不抛错 ----
console.log('\n--- 2. 缺失与非法 id 返回 null ---');
check('不存在的通道返回 null', iconOf('nosuchchannel'), null);
check('带路径穿越的字符返回 null', iconOf('../etc/passwd'), null);
check('大写字母不在白名单里', iconOf('Workbuddy'), null);
check('空串返回 null', iconOf(''), null);

// ---- 3. 缓存 ----
console.log('\n--- 3. 缓存 ---');
const first = iconOf('loomy');
const second = iconOf('loomy');
checkTrue('两次调用返回同一个字符串实例（说明走了缓存）', first === second);
resetChannelIconCacheForTests();
checkTrue('清缓存后仍能读出来', typeof iconOf('loomy') === 'string');

// ---- 4. 兜底字母 ----
console.log('\n--- 4. 兜底字母 ---');
check('取 label 首字母并大写', letterOf({ id: 'loomy', label: 'loomy' }), 'L');
check('label 为空时退回 id', letterOf({ id: 'werk', label: '' }), 'W');
check('中文 label 不炸', letterOf({ id: 'x', label: '测试通道' }), '测');

console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail} 项失败`);
assert.equal(fail, 0);
