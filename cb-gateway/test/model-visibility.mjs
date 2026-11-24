// 模型可见性的回归测试：`channel_visibility` 表的读写（v4 起进库，不再是 `config.json`）。
//
// 全部跑在临时目录（QB_DATA_DIR）里 —— 库文件落在临时目录，不碰真实数据。
//
// **只管数据层**：2026-11-13 SPA 转正时，这里原来还有一节「模型页的勾选渲染」，
// 测的是 `src/ui/models-page.ts`——那个模块已经删了，界面在 `web/src/views` 里。
//
// 跑：node test/model-visibility.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-gw-visibility-'));
process.env.QB_DATA_DIR = tempData;

const vis = await import('../src/shared/model-visibility.ts');
const { db, closeDb } = await import('../src/shared/db.ts');

const rows = () => db.prepare('SELECT channel_prefix, listed, models FROM channel_visibility ORDER BY channel_prefix').all();
const MODELS = [
  { id: 'a', name: 'A' },
  { id: 'b', name: 'B' },
  { id: 'c', name: 'C' },
];

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

// ---- 1. 没配置过 = 全部显示 ----
check('没有任何行时不算有限制', vis.visibleFor('workbuddy'), null);
check('没限制时原样返回', vis.filterModels('workbuddy', MODELS).map((m) => m.id), ['a', 'b', 'c']);
check('没配置过时表是空的（不编默认行）', rows(), []);

// ---- 2. 保存一份清单，顺序按清单来 ----
vis.setVisibleFor('workbuddy', ['c', 'a', 'ghost']);
check('按清单顺序过滤', vis.filterModels('workbuddy', MODELS).map((m) => m.id), ['c', 'a']);
check('上游已经没有的 id 被丢掉，不报错', vis.filterModels('workbuddy', MODELS).length, 2);
check('库里存的是 JSON 数组', JSON.parse(rows()[0].models), ['c', 'a', 'ghost']);

// ---- 3. 空数组 ≠ 没配置：一个都不显示 ----
vis.setVisibleFor('workbuddy', []);
check('空数组就是「一个都不显示」', vis.filterModels('workbuddy', MODELS).length, 0);
check('空数组仍算「有配置」', vis.visibleFor('workbuddy'), []);

// ---- 4. null = 删掉限制 ----
vis.setVisibleFor('workbuddy', null);
check('删限制后恢复全部', vis.visibleFor('workbuddy'), null);
check('删掉限制后这一行整个消失（回到默认）', rows().some((r) => r.channel_prefix === 'workbuddy'), false);

// ---- 5. 去重与非法值 ----
vis.setVisibleFor('trae', ['a', 'a', 'b', '', 42]);
check('重复 id 去重、非字符串丢掉', vis.visibleFor('trae'), ['a', 'b']);

// ---- 6. 通道总闸 ----
check('默认是打开的（没有行）', vis.isListed('workbuddy'), true);
vis.setListed('workbuddy', false);
check('关掉后 isListed 为 false', vis.isListed('workbuddy'), false);
check('关掉后模型列表一个都不回', vis.filterModels('workbuddy', MODELS).length, 0);
check('关掉时库里 listed=0', rows().find((r) => r.channel_prefix === 'workbuddy').listed, 0);
check('关掉不影响别的通道', vis.isListed('trae'), true);
check('关掉不动清单', vis.visibleFor('trae'), ['a', 'b']);
vis.setListed('workbuddy', true);
check('打开后那一行删掉（而不是写 listed=1）', rows().some((r) => r.channel_prefix === 'workbuddy'), false);
check('打开后模型列表恢复', vis.filterModels('workbuddy', MODELS).map((m) => m.id), ['a', 'b', 'c']);

// 总闸关掉、清单也在时：打开总闸应该把清单留着。
vis.setVisibleFor('qoder', ['b']);
vis.setListed('qoder', false);
vis.setListed('qoder', true);
check('打开总闸不清掉清单', vis.visibleFor('qoder'), ['b']);

// ---- 7. 「文件坏了当没限制」这一组已经删掉 ----
//
// 进库之前这里往 config.json 塞半截 JSON，验证「坏文件当没限制」。SQLite 给不出
// 半行，`models` 列也是 TEXT + JSON 校验过的，坏 JSON 根本写不进去；读的时候
// 仍然留了 catch（`store/settings.ts` 的 `parseIds`），但那属于防御，不是主路径。

// ---- 8. 索引缓存：写后立刻可读 + 返回值不能被就地改污染 ----
//
// 2026-11-22 给 `rowOf()` 加了内存索引（原来每次 `listVisibility()` 全表读一遍，
// 而 `filterModels()` 一次要问两次，`/api/models` 又是每通道每账号各问一遍）。
// 缓存的两个**静默**风险各钉一条：
//
//   ① 写完忘了失效 → 「改了可见性但 DSH 那边模型没变」，重启才恢复
//   ② 把缓存里的数组交出去 → 调用方 push 一下就改了缓存，而 `setListed()` 恰好
//      会拿这个返回值去写库，于是「关总闸」可能顺手把清单也改掉
{
  vis.setVisibleFor('loomy', ['x', 'y']);
  check('写后立刻读到清单', vis.visibleFor('loomy'), ['x', 'y']);

  const borrowed = vis.visibleFor('loomy');
  borrowed.push('ghost');
  check('visibleFor 就地改不污染缓存', vis.visibleFor('loomy'), ['x', 'y']);

  vis.setListed('loomy', false);
  check('关总闸立刻生效', vis.isListed('loomy'), false);
  check('关总闸后清单没被污染', vis.visibleFor('loomy'), ['x', 'y']);

  vis.setListed('loomy', true);
  check('打开后清单还在', vis.visibleFor('loomy'), ['x', 'y']);

  vis.setVisibleFor('loomy', null);
  check('清清单后立刻是 null', vis.visibleFor('loomy'), null);
}

// 先关库再删临时目录：Windows 上删不掉一个被打开的文件（EPERM）。
closeDb();
fs.rmSync(tempData, { recursive: true, force: true });

console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
