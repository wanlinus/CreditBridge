// 模型设置：档位推导 + 上下文窗口覆盖。
//
// 这几条是「网关是唯一事实源」的地基，任何一条错了都不会报错，只会让界面显示的和
// 实际发出去的不一样：
//   · 上游没报档位表 → 用网关的兜底（插件不再自己补一套）
//   · 上游的 `none` → 归一成 DSH 认识的 `off`
//   · 没配过档位 → 默认是档位表里**最高**那一档（「默认打开思考」）
//   · 配了个不在表里的档 → 不信它，退回最高档（写进去上游不认只会静默按默认跑）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-model-settings-'));
process.env.QB_DATA_DIR = tempData;

const {
  FALLBACK_EFFORTS,
  MIN_CONTEXT,
  MAX_CONTEXT,
  applyModelSettings,
  effortsOf,
  effectiveEffort,
  highestEffort,
  settingOf,
  writeSetting,
} = await import('../src/shared/model-settings.ts');

const checks = [];
const check = (name, ok) => checks.push([name, ok]);

const model = (extra) => ({
  id: 'hy4free',
  object: 'model',
  name: 'Hy4',
  context_length: 1000000,
  max_output_tokens: 32000,
  ...extra,
});

// ---- 档位归一与兜底 ----
{
  const fallback = effortsOf(model({ reasoning: true }));
  check('上游没报档位 → 用网关兜底', JSON.stringify(fallback) === JSON.stringify(FALLBACK_EFFORTS));
  check('兜底里含 off（关闭思考）', fallback.includes('off'));

  const normalized = effortsOf(model({ reasoning: true, reasoningEfforts: ['none', 'low', 'high'] }));
  check('上游的 none 归一成 off', JSON.stringify(normalized) === JSON.stringify(['off', 'low', 'high']));

  const dedup = effortsOf(model({ reasoning: true, reasoningEfforts: ['low', 'LOW', 'none', 'off'] }));
  check('大小写与重复合并', JSON.stringify(dedup) === JSON.stringify(['low', 'off']));

  check('不能思考的模型没有档位', effortsOf(model({ reasoning: false })).length === 0);
  check(
    '只报 off 等于不能思考，退回兜底',
    JSON.stringify(effortsOf(model({ reasoning: true, reasoningEfforts: ['off'] }))) ===
      JSON.stringify(FALLBACK_EFFORTS),
  );
}

// ---- 最高档 ----
{
  check('最高档跳过 off', highestEffort(['off', 'low', 'xhigh']) === 'xhigh');
  check('最高档取表里最后一个非 off', highestEffort(['off', 'low', 'medium', 'high']) === 'high');
  check('只有 off 时没有最高档', highestEffort(['off']) === null);
  // Qoder 的 `thinking_config.efforts` 是降序下发的（实测 ["xhigh","high","low"]）。
  // 按数组顺序取最后一个会得到 `low`——默认档比用户手动选的最低档还低，而且不报错。
  check('上游降序排列时仍取真正最高的档', highestEffort(['off', 'xhigh', 'high', 'low']) === 'xhigh');
  check('乱序也不影响', highestEffort(['medium', 'off', 'max', 'low']) === 'max');
}

// ---- 缺省档：没配过 = 最高档 ----
{
  const m = model({ reasoning: true, reasoningEfforts: ['off', 'low', 'medium', 'high'] });
  check('没配过 → 缺省是最高档', effectiveEffort('wb', m) === 'high');
  check('不思考的模型没有缺省档', effectiveEffort('wb', model({ reasoning: false })) === null);
}

// ---- 落盘与生效值 ----
{
  writeSetting('wb', 'hy4free', { contextWindow: 400000, reasoningEffort: 'low' });
  const saved = settingOf('wb', 'hy4free');
  check('设置能落盘并读回', saved?.contextWindow === 400000 && saved?.reasoningEffort === 'low');

  const m = model({ reasoning: true, reasoningEfforts: ['off', 'low', 'high'] });
  const applied = applyModelSettings('wb', m);
  check('覆盖值进 context_length', applied.context_length === 400000);
  check('配过的档就是缺省档', applied.defaultReasoningEffort === 'low');
  check('档位表原样报出去', JSON.stringify(applied.reasoningEfforts) === JSON.stringify(['off', 'low', 'high']));

  // 传 null 恢复默认：行要被删掉，而不是留一行全 null
  writeSetting('wb', 'hy4free', { contextWindow: null, reasoningEffort: null });
  const cleared = settingOf('wb', 'hy4free');
  check('null 会删掉那一行（而不是留 null）', cleared === undefined);
  const { db } = await import('../src/shared/db.ts');
  check(
    '库里不留空行',
    db.prepare("SELECT COUNT(*) AS n FROM model_setting WHERE channel_prefix = 'wb' AND model_id = 'hy4free'").get().n === 0,
  );
}

// ---- 配了个表里没有的档 → 不信它 ----
{
  writeSetting('wb', 'bogus', { reasoningEffort: 'max' });
  const m = { ...model({ reasoning: true, reasoningEfforts: ['off', 'low', 'high'] }), id: 'bogus' };
  check('表里没有的档退回最高档', effectiveEffort('wb', m) === 'high');
}

// ---- 不思考的模型不报档位字段 ----
{
  const applied = applyModelSettings('wb', model({ reasoning: false, id: 'plain' }));
  check('不思考的模型不带 reasoningEfforts', applied.reasoningEfforts === undefined);
  check('不思考的模型不带 defaultReasoningEffort', applied.defaultReasoningEffort === undefined);
}

// ---- 上下文窗口的缺省值：取最大 ----
{
  const { maxContextOf, contextOptions } = await import('../src/shared/model-settings.ts');
  check('有档位表 → 取最大档', maxContextOf({ default: 300000, options: [300000, 600000, 1000000] }, 200000) === 1000000);
  check(
    '档位表里的 default 小于上限时，仍取上限（不是跟随 default）',
    maxContextOf({ default: 128000, options: [128000, 256000, 1000000] }, 200000) === 1000000,
  );
  check('没有档位表 → 用上游报的值', maxContextOf(null, 300000) === 300000);
  check('档位表是空数组 → 用上游报的值', maxContextOf({ options: [] }, 300000) === 300000);

  // 上游没给档位表时按上限推三档——**上下文永远是下拉**，不做自由填数字。
  check('推档位：50%/75%/100%', JSON.stringify(contextOptions(256000)) === JSON.stringify([128000, 192000, 256000]));
  check('推档位：非整千的上限就近取千', JSON.stringify(contextOptions(981504)) === JSON.stringify([491000, 736000, 981504]));
  check('推档位：非法上限给空表', JSON.stringify(contextOptions(0)) === '[]');
}

// ---- 边界常量 ----
check('上下文下限是 8000', MIN_CONTEXT === 8000);
check('上下文上限是 2000000', MAX_CONTEXT === 2000000);

// ---- 索引缓存：写后必须立刻可读，返回值不能被就地改污染 ----
//
// 2026-11-22 给 `settingOf()` 加了内存索引（原来每次调用都全表读一遍，`/api/models`
// 是「账号数 × 模型数」次调用，实测 180 次 = 26ms，而插件每 15 秒拉一次）。
// 缓存带来两个**静默**风险，这两条钉住它们：
//
//   ① 写完忘了失效 → 「保存成功但界面数字不变」，只有重启才恢复
//   ② 把缓存本体交出去 → 调用方就地改一个字段，下一次读到的就是被改过的值
//
// ② 我第一版就是错的：只写了 `{ ...settingsIndex() }`，那挡不住「改 entry 里的字段」。
{
  const { allSettings } = await import('../src/shared/model-settings.ts');

  writeSetting('wb', 'cache-a', { contextWindow: 111 });
  check('写后立刻可读', settingOf('wb', 'cache-a')?.contextWindow === 111);

  writeSetting('wb', 'cache-a', { reasoningEffort: 'high' });
  check('追加字段后两个都在', settingOf('wb', 'cache-a')?.contextWindow === 111 && settingOf('wb', 'cache-a')?.reasoningEffort === 'high');

  const snapshot = allSettings();
  snapshot['wb/cache-a'].contextWindow = 999;
  check('allSettings 就地改不污染缓存', settingOf('wb', 'cache-a')?.contextWindow === 111);

  const one = settingOf('wb', 'cache-a');
  one.contextWindow = 888;
  check('settingOf 就地改不污染缓存', settingOf('wb', 'cache-a')?.contextWindow === 111);

  writeSetting('wb', 'cache-a', { contextWindow: null, reasoningEffort: null });
  check('清空后立刻读不到', settingOf('wb', 'cache-a') === undefined);
}

let bad = 0;
for (const [name, ok] of checks) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + name);
  if (!ok) bad += 1;
}
// 先关库再删临时目录：Windows 上删不掉一个被打开的文件（EPERM）。
const { closeDb } = await import('../src/shared/db.ts');
closeDb();
fs.rmSync(tempData, { recursive: true, force: true });
console.log(bad === 0 ? `\n全部通过（${checks.length} 项）` : `\n${bad} 项失败`);
process.exit(bad === 0 ? 0 : 1);
