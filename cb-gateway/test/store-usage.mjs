// `src/store/usage.ts` 的自测。
//
// 这一层进库之后，**SQL 写错不会报错，只会让数字悄悄错**：`COALESCE` 少写一个，
// `prompt + completion` 里有一个是 NULL 就整行算成 0；`GROUP BY` 忘了归一空值，
// 堆叠图就少一段。这里逐条钉住这些「不报错但错」的地方。
//
// 另一个重点是**空值的语义**：上游没报的字段存 NULL，不当 0 存（`private/docs/v4` §3.1）。
// 但聚合时必须按 0 参与相加——这两件事不矛盾，一个是存储，一个是统计口径。
//
// 跑：node test/store-usage.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-gw-store-usage-'));
process.env.QB_DATA_DIR = tempData;

const S = await import('../src/store/usage.ts');

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

const NOW = Date.now();
const DAY = 86400000;
const startOfToday = new Date(NOW);
startOfToday.setHours(0, 0, 0, 0);
// 用「今天 1 点」和「昨天 1 点」这类确定属于某一天的时刻，避免跑测试时正好跨零点。
const TODAY = startOfToday.getTime() + 3600000;
const YESTERDAY = startOfToday.getTime() - DAY + 3600000;

const rows = [
  // 今天 wb-1：输入 100、命中 60、输出 20 → 未命中 40
  {
    ts: TODAY, provider: 'workbuddy', account: 'wb-1', model: 'm1', effort: 'high',
    credit: 5, promptTokens: 100, completionTokens: 20, cachedTokens: 60,
    reasoningTokens: 7, totalTokens: 120, cacheWriteTokens: 3, durationMs: 800, status: 200,
  },
  // 今天 wb-1：上游没报输出 → NULL 不能变成 NaN，按 0 参与相加
  { ts: TODAY + 1000, provider: 'workbuddy', account: 'wb-1', model: 'm1', credit: 1, promptTokens: 50, status: 499, durationMs: 300 },
  // 昨天 trae-3：整行只有最小字段（模拟旧行：没有 account / token 全空）
  { ts: YESTERDAY, provider: 'trae', model: 'm2', credit: null, status: 502 },
  // 20 天前：只该出现在 totals 里，不进 14 天窗口
  { ts: NOW - 20 * DAY, provider: 'workbuddy', model: 'm3', credit: 100, promptTokens: 999, status: 200 },
  // status 缺失 → 计数归 (none) 一档，不能丢
  { ts: TODAY + 2000, provider: 'loomy', provider2: 'x', credit: 0, promptTokens: 0, status: null },
];
for (const row of rows) S.insertUsage(row);

console.log('--- 1. 写入与计数 ---');
check('countUsage 等于插入行数', S.countUsage(), 5);
check('insertUsage 把缺的字段存成 NULL 而不是 0', (() => {
  const totals = S.usageTotals({ provider: 'trae' });
  // 那一行没有任何 token：统计按 0，但库里是 NULL（下面单独验库里的值）
  return totals.tokens;
})(), 0);
{
  const { db } = await import('../src/shared/db.ts');
  const row = db.prepare("SELECT prompt_tokens, completion_tokens, credit FROM usage_record WHERE provider = 'trae'").get();
  check('库里存的确实是 NULL', [row.prompt_tokens, row.completion_tokens, row.credit], [null, null, null]);
}

console.log('\n--- 2. 汇总：token 是主口径 ---');
const all = S.usageTotals({});
check('requests 全部算上', all.requests, 5);
check('tokens = 输入 + 输出', all.tokens, 100 + 20 + 50 + 0 + 999 + 0 + 0);
check('cachedTokens 单独聚合（是 prompt 的子集，不能加进 tokens）', all.cachedTokens, 60);
check('reasoningTokens 单独聚合', all.reasoningTokens, 7);
check('credit 为 NULL 的行按 0 相加', all.credits, 5 + 1 + 0 + 100 + 0);

console.log('\n--- 3. 状态码计数 ---');
const counts = S.usageStatusCounts({});
check('200 两次', counts['200'], 2);
check('499 一次', counts['499'], 1);
check('502 一次', counts['502'], 1);
check('status 为 NULL 归 (none)', counts['(none)'], 1);

console.log('\n--- 4. 今天 vs 全量 ---');
const today = S.usageTotals({}, startOfToday.getTime());
check('今天的请求只算今天', today.requests, 3);
check('今天的 tokens', today.tokens, 100 + 20 + 50);
check('20 天前那行仍在全量里', all.tokens - today.tokens, 999);

console.log('\n--- 5. 分天分桶（三个维度）---');
const daily = S.usageDailyGroups({}, startOfToday.getTime() - 13 * DAY);
const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
check('day 是本地日历日形状 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(daily[0].day), true);
check('今天那一格就是今天', daily[0].day, dayKey(TODAY));
// 今天三行分成两格：wb-1/m1 两行合一起，loomy 那行一组（model 为 NULL）。
check('今天 requests 合计 3', daily.filter((g) => g.day === dayKey(TODAY)).reduce((s, g) => s + g.requests, 0), 3);
check('昨天 requests 合计 1', daily.filter((g) => g.day === dayKey(YESTERDAY)).reduce((s, g) => s + g.requests, 0), 1);
check('20 天前那行被 WHERE 挡掉（窗口内合计 4）', daily.reduce((s, g) => s + g.requests, 0), 4);
check('model 为 NULL 时原样返回，归一交给调用方', daily.some((g) => g.model === null), true);

console.log('\n--- 6. 按模型 / 按账号分组 ---');
const models = S.usageModelGroups({});
const m1 = models.find((g) => g.key === 'm1');
check('m1 两次请求', m1.requests, 2);
check('m1 的 token（120 + 50）', m1.tokens, 170);
check('m1 的 prompt（100 + 50）', m1.promptTokens, 150);
check('m1 的输出只算报了的那次', m1.completionTokens, 20);
const accounts = S.usageAccountGroups({});
check('空账号归 (未标注) 而不是丢掉', accounts.map((g) => g.key).sort(), ['(未标注)', 'wb-1']);
const todayAccounts = S.usageAccountGroups({}, startOfToday.getTime());
check('今天的账号分组只含今天', todayAccounts.reduce((s, g) => s + g.requests, 0), 3);

// 缓存量必须按账号聚合出来，否则概览页「今天有多少输入是全价」算不出来。
// 这条钉的是 2026-11-22 那次：lo-1 一次 69 万 token 只命中 1.3%，但被 wb 的
// 1.19 亿 token 稀释成全账号 1.1%，卡片上什么都显示不出来。
check(
  '账号分组带 cachedTokens',
  todayAccounts.every((g) => typeof g.cachedTokens === 'number'),
  true,
);
check(
  '账号分组的 cachedTokens 是各账号自己的合计',
  todayAccounts.map((g) => `${g.key}:${g.cachedTokens}`).sort(),
  ['(未标注):0', 'wb-1:60'],
);

console.log('\n--- 7. 最近请求：成功与非成功各一批 ---');
// 先插 12 条 200，再插 12 条 500，验证「各取 10」而不是「最后 10 条」。
for (let i = 0; i < 12; i += 1) {
  S.insertUsage({ ts: NOW + i, provider: 'trae', model: 'ok' + i, credit: 1, promptTokens: 1, status: 200 });
}
for (let i = 0; i < 12; i += 1) {
  S.insertUsage({ ts: NOW + 100 + i, provider: 'trae', model: 'bad' + i, credit: 0, promptTokens: 1, status: 500 });
}
const recent = S.usageRecent({ provider: 'trae' }, 10);
check('成功那批取到 10 条', recent.ok.length, 10);
check('非成功那批也取到 10 条（不是被 500 挤没）', recent.bad.length, 10);
check('成功那批全是 200', recent.ok.every((r) => r.status === 200), true);
check('非成功那批没有 200', recent.bad.every((r) => r.status !== 200), true);
check('字段名归一成 camelCase', Object.keys(recent.ok[0]).includes('promptTokens'), true);
check('没有 snake_case 残留', Object.keys(recent.ok[0]).includes('prompt_tokens'), false);

console.log('\n--- 8. 计价用的列 / 耗时列 ---');
const pricing = S.usagePricingRows({ provider: 'workbuddy' }, startOfToday.getTime());
// `provider` 是 2026-11-13 加的：计价时要按通道套「假定缓存命中」（Trae 不报缓存），
// 所以这一行必须带得上通道。`cachedTokens` 保留 `null`（上游没报），不在这里补 0。
check('计价行的字段', Object.keys(pricing[0]).sort(), ['cachedTokens', 'completionTokens', 'promptTokens', 'provider', 'ts']);
check('计价行按今天筛选', pricing.length, 2);
const durations = S.usageDurations({ provider: 'workbuddy' }, startOfToday.getTime());
check('耗时列跳过 NULL', durations.sort((a, b) => a - b), [300, 800]);

console.log('\n--- 9. 筛选条件 ---');
check('按账号筛选', S.usageTotals({ account: 'wb-1' }).requests, 2);
check('按通道筛选', S.usageTotals({ provider: 'trae' }).requests, 25);
check('未知通道 → 0 行，不是报错', S.usageTotals({ provider: 'nope' }).requests, 0);
check('通道 + 账号同时筛', S.usageTotals({ provider: 'trae', account: 'wb-1' }).requests, 0);

console.log('\n--- 10. 窄查询必须和宽查询同口径 ---');
//
// 2026-11-22 加了两个「只要几个数字」的窄查询，替掉两处 `usageSummary()`：
//   · `usageAccountTokens()`  → `GET /api/accounts` 每行的今日/近30天 token
//   · `usageAccountToday()`   → 徽标（每 60 秒轮询一次）
//
// **这条测试是那次改动的唯一保险**：窄查询和宽查询对同一批数据必须给出同一组数字。
// 口径分叉时两边都不报错，表现是「账号列表页和概览页对同一个号显示不同的数字」，
// 或者徽标上的「今日」和概览卡上的「今日」差一点——只能靠人眼发现。
{
  // 全时段：窄查询按账号的 token 合计，必须等于宽查询按账号分组的 tokens。
  const wide = S.usageAccountGroups({});
  const narrow = S.usageAccountTokens({}, 0);
  check(
    'usageAccountTokens 与 usageAccountGroups 的 tokens 逐账号一致',
    wide.map((g) => `${g.key}:${g.tokens}`).sort(),
    Object.entries(narrow).map(([k, v]) => `${k}:${v}`).sort(),
  );

  // 空账号归 `(未标注)` 这条归一规则也必须一致（否则两边会多出/少掉一档）。
  check('两边都归 (未标注)', narrow['(未标注)'], wide.find((g) => g.key === '(未标注)').tokens);

  // 单账号今日三连：必须和 usageTotals 同窗口、同账号的结果逐项相等。
  const since = startOfToday.getTime();
  const wideToday = S.usageTotals({ account: 'wb-1' }, since);
  const narrowToday = S.usageAccountToday('wb-1', since);
  check('usageAccountToday.requests 与 usageTotals 一致', narrowToday.requests, wideToday.requests);
  check('usageAccountToday.tokens 与 usageTotals 一致', narrowToday.tokens, wideToday.tokens);
  check('usageAccountToday.credits 与 usageTotals 一致', narrowToday.credits, wideToday.credits);

  // 没有记录的账号：三个数都是 0，不是 null / NaN。
  const empty = S.usageAccountToday('no-such-account', since);
  check('不存在的账号三个数都是 0', [empty.requests, empty.tokens, empty.credits], [0, 0, 0]);
}

// 先关库再删临时目录：Windows 上删不掉一个被打开的文件（EPERM）。
const { closeDb } = await import('../src/shared/db.ts');
closeDb();
fs.rmSync(tempData, { recursive: true, force: true });
console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
