// Qoder 的 prompt 字符闸：上限必须跟着模型窗口走，不能写死。
//
// 起因（2026-11-21）：`qd-1/DeepSeek-Flash` 一轮 574849 字符被网关拒，
// `qoder_prompt_too_long`。查下来是三处口径打架：
//
//   /v1/models 报给 DSH 的窗口   1000000 token（上游 context_config 最大档）
//   传给 CLI 的 --context-window 1000000
//   网关自己放行的 prompt        200000 字符（写死）
//
// DSH 按 1M token 规划压缩，57 万字符在它看来远远没到线，于是照发；网关在 20 万
// 字符处整条拒绝。两边永远对不齐，这条通道的会话一长就必死，且失败点固定。
//
// 这个测试钉住两件事：
//   1. 上限由窗口推导，窗口越大上限越大（不能再是常数）；
//   2. 拿不到窗口时才回落 20 万，且回落值本身不能被当成"正常上限"。
//
// 跑：node test/qoder-prompt-limit.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 必须在 import 业务模块之前设：`paths.ts` 在模块加载时就读它。
const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-qoder-limit-'));
process.env.QB_DATA_DIR = tempData;

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

const { promptLimitOf } = await import('../src/channels/qoder/upstream.ts');
const { contextWindowOf, effectiveContextWindowOf } = await import('../src/channels/qoder/models.ts');
const { writeSetting } = await import('../src/shared/model-settings.ts');

console.log('--- 1. 上限跟着窗口走 ---');
check('1M 窗口的上限远大于旧的 20 万', promptLimitOf(1_000_000) > 200_000, true);
check('1M 窗口 → 150 万字符', promptLimitOf(1_000_000), 1_500_000);
check('200K 窗口 → 30 万字符', promptLimitOf(200_000), 300_000);
check('400K 窗口 → 60 万字符', promptLimitOf(400_000), 600_000);
check('窗口翻倍，上限也翻倍', promptLimitOf(400_000) / promptLimitOf(200_000), 2);
check('上限随窗口单调不减', promptLimitOf(1_000_000) > promptLimitOf(400_000), true);

console.log('\n--- 2. 拿不到窗口时兜底 ---');
check('null 回落 20 万', promptLimitOf(null), 200_000);
check('0 回落 20 万', promptLimitOf(0), 200_000);
check('负数回落 20 万', promptLimitOf(-1), 200_000);
check('NaN 回落 20 万', promptLimitOf(Number.NaN), 200_000);
check('Infinity 回落 20 万', promptLimitOf(Number.POSITIVE_INFINITY), 200_000);

console.log('\n--- 3. 和上报给 DSH 的窗口同源（这次报错的根因）---');
// 快照里 DeepSeek-Flash 的 context_config 是 200K/400K/1M，最大 1M。
// 报给 DSH 的是 1M，所以闸门必须按 1M 算——这是"两边口径一致"的判据。
const reported = contextWindowOf('DeepSeek-Flash');
check('快照里 DeepSeek-Flash 的窗口是 1M', reported, 1_000_000);
check(
  '闸门按上报窗口算，而不是另取一个数',
  promptLimitOf(reported),
  promptLimitOf(1_000_000),
);
// 574849 是这次真实被拒的字符数，它必须能过 1M 窗口的闸门。
check('574849 字符在 1M 窗口下放行', 574_849 <= promptLimitOf(reported), true);

console.log('\n--- 4. 窗口未知时退回默认值（模型不在快照里）---');
const unknown = contextWindowOf('这个模型不在快照里');
check('未知模型返回 null', unknown, null);
check('未知模型走兜底', promptLimitOf(unknown), 200_000);

console.log('\n--- 5. 用户在 /models 页配的窗口必须生效 ---');
// 这一节钉的是「同一个 bug 换个数字复现」：窗口允许配到 2M（MAX_CONTEXT），
// 若聊天路径只读快照的 1M，DSH 按 2M 规划、闸门按 1M 拒，症状和这次报错一模一样。
check('没配过时等于快照值', effectiveContextWindowOf('qd', 'DeepSeek-Flash'), 1_000_000);

writeSetting('qd', 'DeepSeek-Flash', { contextWindow: 2_000_000 });
check('配了 2M 就报 2M', effectiveContextWindowOf('qd', 'DeepSeek-Flash'), 2_000_000);
check('闸门跟着配的值放大', promptLimitOf(effectiveContextWindowOf('qd', 'DeepSeek-Flash')), 3_000_000);
check(
  '配大之后，原先会被拒的 250 万字符能过',
  2_500_000 <= promptLimitOf(effectiveContextWindowOf('qd', 'DeepSeek-Flash')),
  true,
);

writeSetting('qd', 'DeepSeek-Flash', { contextWindow: 200_000 });
check('配了 200K 就报 200K（不是快照的 1M）', effectiveContextWindowOf('qd', 'DeepSeek-Flash'), 200_000);
check('闸门跟着缩小', promptLimitOf(effectiveContextWindowOf('qd', 'DeepSeek-Flash')), 300_000);
// 缩小时最容易漏：报给 DSH 的是 200K，闸门要是还按 1M 算，DSH 就会发出
// 超出窗口的内容——反过来变成「上游按上下文超限拒」，一样难查。
check(
  '配小之后，574849 字符必须被拒',
  574_849 <= promptLimitOf(effectiveContextWindowOf('qd', 'DeepSeek-Flash')),
  false,
);

// 清空设置，恢复跟随上游
writeSetting('qd', 'DeepSeek-Flash', { contextWindow: null });
check('清空后回到快照值', effectiveContextWindowOf('qd', 'DeepSeek-Flash'), 1_000_000);

// 先关库再删临时目录：Windows 上删不掉一个被打开的文件（EPERM）。
const { closeDb } = await import('../src/shared/db.ts');
closeDb();
fs.rmSync(tempData, { recursive: true, force: true });
console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
