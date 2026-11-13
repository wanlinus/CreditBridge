import assert from 'node:assert/strict';

import { effectiveDeviceId, mintSelfDeviceId } from '../src/channels/trae/auth.ts';
import { traeChannel } from '../src/channels/trae/index.ts';

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

console.log('--- 1. effectiveDeviceId 优先级 ---');
check('aha 真号优先', effectiveDeviceId({ checkinDeviceId: '1111111111111111', selfDeviceId: '2222222222222222' }), '1111111111111111');
check('aha 号为空时退回自造号', effectiveDeviceId({ checkinDeviceId: '', selfDeviceId: '2222222222222222' }), '2222222222222222');
check('两者都空时回空串（不是 machineId）', effectiveDeviceId({ checkinDeviceId: '', selfDeviceId: '', machineId: 'a76c383d' }), '');
check('machineId 绝不参与', effectiveDeviceId({ machineId: 'a76c383d' }), '');

console.log('\n--- 2. rotateDeviceIdOf ---');
check('Trae 实现了 rotateDeviceIdOf', typeof traeChannel.rotateDeviceIdOf, 'function');

const before = { checkinDeviceId: '1111111111111111', selfDeviceId: '2222222222222222' };
const rotated = traeChannel.rotateDeviceIdOf();
check('返回了新的 selfDeviceId', typeof rotated.selfDeviceId, 'string');
check('新号是 16 位十进制', /^[1-9][0-9]{15}$/.test(rotated.selfDeviceId), true);
check('返回里不碰 checkinDeviceId', Object.prototype.hasOwnProperty.call(rotated, 'checkinDeviceId'), false);
check('返回里不碰 token 等其它字段', Object.keys(rotated), ['selfDeviceId']);

const merged = { ...before, ...rotated };
check('合并后 checkinDeviceId 原样保留', merged.checkinDeviceId, '1111111111111111');
check('合并后 selfDeviceId 换成新的', merged.selfDeviceId, rotated.selfDeviceId);

console.log('\n--- 3. mintSelfDeviceId 形状 ---');
const a = mintSelfDeviceId();
const b = mintSelfDeviceId();
check('16 位十进制', /^[1-9][0-9]{15}$/.test(a), true);
check('首位不为 0', a.startsWith('0'), false);
check('两次生成不重复（概率上）', a === b, false);

console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
