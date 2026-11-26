// `store/usage.ts`：SQL 写错不报错只会让数字悄悄错（COALESCE 漏写、GROUP BY 没归一空值、NULL 变 NaN）。逐条钉住这些「不报错但错」的地方。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, section, done } from './_helpers.mjs';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-gw-store-usage-'));
process.env.QB_DATA_DIR = tempData;

const S = await import('../src/store/usage.ts');

const NOW = Date.now();
const DAY = 86400000;
const startOfToday = new Date(NOW);
startOfToday.setHours(0, 0, 0, 0);
// 用「今天 1 点」「昨天 1 点」这类确定时刻，避免跑测试时正好跨零点。
const TODAY = startOfToday.getTime() + 3600000;
const YESTERDAY = startOfToday.getTime() - DAY + 3600000;

const rows = [
  { ts: TODAY, provider: 'workbuddy', account: 'wb-1', model: 'm1', effort: 'high', credit: 5, promptTokens: 100, completionTokens: 20, cachedTokens: 60, reasoningTokens: 7, totalTokens: 120, cacheWriteTokens: 3, durationMs: 800, status: 200 },
  { ts: TODAY + 1000, provider: 'workbuddy', account: 'wb-1', model: 'm1', credit: 1, promptTokens: 50, status: 499, durationMs: 300 },
  { ts: YESTERDAY, provider: 'trae', model: 'm2', credit: null, status: 502 },
  { ts: NOW - 20 * DAY, provider: 'workbuddy', model: 'm3', credit: 100, promptTokens: 999, status: 200 },
  { ts: TODAY + 2000, provider: 'loomy', provider2: 'x', credit: 0, promptTokens: 0, status: null },
];
for (const row of rows) S.insertUsage(row);

section('1. 写入与空值语义');
check('countUsage 等于插入行数', S.countUsage(), 5);
check('insertUsage 把缺的字段存 NULL 而不是 0', S.usageTotals({ provider: 'trae' }).tokens, 0);
{
  const { db } = await import('../src/shared/db.ts');
  const row = db.prepare("SELECT prompt_tokens, completion_tokens, credit FROM usage_record WHERE provider = 'trae'").get();
  check('库里存的确实是 NULL', [row.prompt_tokens, row.completion_tokens, row.credit], [null, null, null]);
}

section('2. 汇总：token 是主口径');
const all = S.usageTotals({});
check('requests 全部算上', all.requests, 5);
check('tokens = 输入 + 输出', all.tokens, 100 + 20 + 50 + 0 + 999 + 0 + 0);
check('cached / reasoning 单独聚合（是 prompt 子集，不进 tokens）', [all.cachedTokens, all.reasoningTokens], [60, 7]);
check('credit 为 NULL 的行按 0 相加', all.credits, 5 + 1 + 0 + 100 + 0);

section('3. 状态码计数（status NULL 归 (none)，不能丢）');
const counts = S.usageStatusCounts({});
check('200/499/502/(none)', [counts['200'], counts['499'], counts['502'], counts['(none)']], [2, 1, 1, 1]);

section('4. 今天 vs 全量');
const today = S.usageTotals({}, startOfToday.getTime());
check('今天只算今天', [today.requests, today.tokens], [3, 100 + 20 + 50]);
check('20 天前那行仍在全量里', all.tokens - today.tokens, 999);

section('5. 分天分桶');
const daily = S.usageDailyGroups({}, startOfToday.getTime() - 13 * DAY);
const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
check('day 是 YYYY-MM-DD 形状、今天那一格就是今天', [daily[0].day, /^\d{4}-\d{2}-\d{2}$/.test(daily[0].day)], [dayKey(TODAY), true]);
check('今天 / 昨天 requests 合计', [daily.filter((g) => g.day === dayKey(TODAY)).reduce((s, g) => s + g.requests, 0), daily.filter((g) => g.day === dayKey(YESTERDAY)).reduce((s, g) => s + g.requests, 0)], [3, 1]);
check('20 天前那行被 WHERE 挡掉（窗口内 4）', daily.reduce((s, g) => s + g.requests, 0), 4);
check('model 为 NULL 原样返回，归一交给调用方', daily.some((g) => g.model === null), true);

section('6. 按模型 / 按账号分组');
const models = S.usageModelGroups({});
const m1 = models.find((g) => g.key === 'm1');
check('m1 两次请求、token/prompt/输出', [m1.requests, m1.tokens, m1.promptTokens, m1.completionTokens], [2, 170, 150, 20]);
const accounts = S.usageAccountGroups({});
check('空账号归 (未标注) 而不是丢掉', accounts.map((g) => g.key).sort(), ['(未标注)', 'wb-1']);
const todayAccounts = S.usageAccountGroups({}, startOfToday.getTime());
check('今天的账号分组只含今天', todayAccounts.reduce((s, g) => s + g.requests, 0), 3);
// 缓存量必须按账号聚合，否则概览页「今天有多少输入是全价」算不出来（2026-11-22 lo-1 一次 69 万只命中 1.3%，被 wb 的 1.19 亿稀释成全账号 1.1%）。
check('账号分组带 cachedTokens、且是各账号自己的合计', todayAccounts.map((g) => `${g.key}:${g.cachedTokens}`).sort(), ['(未标注):0', 'wb-1:60']);

section('7. 最近请求：成功与非成功各取一批');
for (let i = 0; i < 12; i += 1) S.insertUsage({ ts: NOW + i, provider: 'trae', model: 'ok' + i, credit: 1, promptTokens: 1, status: 200 });
for (let i = 0; i < 12; i += 1) S.insertUsage({ ts: NOW + 100 + i, provider: 'trae', model: 'bad' + i, credit: 0, promptTokens: 1, status: 500 });
const recent = S.usageRecent({ provider: 'trae' }, 10);
check('成功 / 非成功各取 10（不是被 500 挤没）', [recent.ok.length, recent.bad.length], [10, 10]);
check('成功批全 200、非成功批没有 200', [recent.ok.every((r) => r.status === 200), recent.bad.every((r) => r.status !== 200)], [true, true]);
check('字段名归一 camelCase、无 snake_case 残留', [Object.keys(recent.ok[0]).includes('promptTokens'), Object.keys(recent.ok[0]).includes('prompt_tokens')], [true, false]);

section('8. 计价行 / 耗时列');
const pricing = S.usagePricingRows({ provider: 'workbuddy' }, startOfToday.getTime());
// provider 是 2026-11-13 加的：计价要按通道套「假定缓存命中」，必须带得上；cachedTokens 保留 null（上游没报）。
check('计价行字段与筛选', [Object.keys(pricing[0]).sort(), pricing.length], [['cachedTokens', 'completionTokens', 'promptTokens', 'provider', 'ts'], 2]);
const durations = S.usageDurations({ provider: 'workbuddy' }, startOfToday.getTime());
check('耗时列跳过 NULL', durations.sort((a, b) => a - b), [300, 800]);

section('9. 筛选条件');
check('按账号 / 通道 / 未知通道 / 通道+账号', [
  S.usageTotals({ account: 'wb-1' }).requests,
  S.usageTotals({ provider: 'trae' }).requests,
  S.usageTotals({ provider: 'nope' }).requests,
  S.usageTotals({ provider: 'trae', account: 'wb-1' }).requests,
], [2, 25, 0, 0]);

section('10. 窄查询与宽查询同口径');
// 2026-11-22 加的窄查询（usageAccountTokens / usageAccountToday）替掉两处 usageSummary，口径分叉时两边都不报错。
{
  const wide = S.usageAccountGroups({});
  const narrow = S.usageAccountTokens({}, 0);
  check('usageAccountTokens 与 usageAccountGroups 逐账号一致', wide.map((g) => `${g.key}:${g.tokens}`).sort(), Object.entries(narrow).map(([k, v]) => `${k}:${v}`).sort());
  check('两边都归 (未标注)', narrow['(未标注)'], wide.find((g) => g.key === '(未标注)').tokens);
  const since = startOfToday.getTime();
  const wideToday = S.usageTotals({ account: 'wb-1' }, since);
  const narrowToday = S.usageAccountToday('wb-1', since);
  check('usageAccountToday 与 usageTotals 同窗口同账号', [narrowToday.requests, narrowToday.tokens, narrowToday.credits], [wideToday.requests, wideToday.tokens, wideToday.credits]);
  const empty = S.usageAccountToday('no-such-account', since);
  check('不存在的账号三个数都是 0', [empty.requests, empty.tokens, empty.credits], [0, 0, 0]);
}

const { closeDb } = await import('../src/shared/db.ts');
closeDb();
fs.rmSync(tempData, { recursive: true, force: true });
done();
