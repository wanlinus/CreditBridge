// `/api/usage` 的 daily 分桶回归测试。
//
// 面板上那张「近 14 天用量」柱状图直接读这个数组，错一天/漏一天都不会报错，只会
// 让图悄悄变形——所以在这里用固定账本核对：条数固定 14、按本地日历日分桶、
// 只算当前通道、14 天以前的不进数组。
//
// **2026-11-13 起主口径是 token**：桶里带 `tokens`（= 输入 + 输出），`credits` 退成
// 「上游顺带报了」的附属信息。断言因此以 token 为准——它是唯一能跨通道相加的量
// （见 private/docs/architecture-decisions.md（ADR-8/ADR-9））。
//
// 跑：node test/usage-daily.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-gw-usage-'));
process.env.QB_DATA_DIR = tempData;

// **v4 起读数走 SQLite**：造数据要写 `usage_record` 表，不再拼 `usage.jsonl`。
// 这比手拼 JSON 字符串更不容易错——少一个逗号是解析失败，少一列是断言失败。
const { insertUsage } = await import('../src/store/usage.ts');

const RIGHT_NOW = Date.now();
const DAY = 86400000;
const records = [
  // 今天：输入 100 + 输出 20 = 120
  { ts: RIGHT_NOW, provider: 'workbuddy', model: 'm', credit: 5, promptTokens: 100, completionTokens: 20, cachedTokens: 60, reasoningTokens: 7 },
  // 昨天：230
  { ts: RIGHT_NOW - DAY, provider: 'workbuddy', model: 'm', credit: 7, promptTokens: 200, completionTokens: 30 },
  // 前天：只有输入（上游没报输出），仍然算 50
  { ts: RIGHT_NOW - 2 * DAY, provider: 'workbuddy', model: 'm', credit: null, promptTokens: 50 },
  // 20 天前：不进 14 天的柱子，但**仍算进「近 30 天」总量**
  { ts: RIGHT_NOW - 20 * DAY, provider: 'workbuddy', model: 'm', credit: 100, promptTokens: 999 },
  // 40 天前：连「近 30 天」也不算——总量类聚合按窗口扫，不是全表
  { ts: RIGHT_NOW - 40 * DAY, provider: 'workbuddy', model: 'm', credit: 500, promptTokens: 777 },
  // 别的通道：不算进来
  { ts: RIGHT_NOW, provider: 'trae', model: 't', credit: 3, promptTokens: 111 },
];
for (const record of records) insertUsage(record);

const { usageSummary } = await import('../src/ledger.ts');

// `usageSummary()` 返回对象（v2 的路由层是 Hono，不再写 res）。
const captured = await usageSummary({ provider: 'workbuddy' });

let fail = 0;
function check(name, actual, expected = true) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}\n      期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

const localDay = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ---- 分桶本身 ----
check('daily 固定 14 天', captured.daily.length, 14);
check('最后一天是今天（按本地日历日）', captured.daily[13].date, localDay(RIGHT_NOW));
check('今天的 token（100 + 20）', captured.daily[13].tokens, 120);
check('昨天的 token（200 + 30）', captured.daily[12].tokens, 230);
check('只有输入时也照算', captured.daily[11].tokens, 50);
check('14 天以前的 tokens 不进数组', captured.daily.reduce((sum, d) => sum + d.tokens, 0), 400);
check('别的通道的 token 不算进来', captured.daily.some((d) => d.tokens === 111), false);
check('没有输出的请求也算一次 requests', captured.daily[11].requests, 1);
check('空的一天补 0 而不是缺项', captured.daily[0].tokens, 0);

// credits 退成附属信息，但仍然要如实透出（上游报了就带着）。
check('今天的 credits 仍然记着', captured.daily[13].credits, 5);
check('窗口内 credits 合计', captured.daily.reduce((sum, d) => sum + d.credits, 0), 12);

// ---- 堆叠图用的三维度分桶 ----
//
// 每根柱子里带 byModel / byAccount / byProvider，前端切换维度时只重画 SVG、不再请求
// 后端。这里钉住三点：三个键都在、值对得上、**旧行缺 account 时归「(未标注)」而不是
// 丢掉**——丢掉的表现是堆叠图某天少一段，而且不报错。
check('今天的 byModel', captured.daily[13].byModel, { m: { tokens: 120, completionTokens: 20, requests: 1, credits: 5 } });
check('今天的 byProvider', captured.daily[13].byProvider, { workbuddy: { tokens: 120, completionTokens: 20, requests: 1, credits: 5 } });
check('旧行没有 account → 归「(未标注)」', captured.daily[13].byAccount, { '(未标注)': { tokens: 120, completionTokens: 20, requests: 1, credits: 5 } });
check('没有 credit 的那天照样进分桶（credits 0）', captured.daily[11].byModel, { m: { tokens: 50, completionTokens: 0, requests: 1, credits: 0 } });
check('空的一天的分桶是空对象，不是缺键', captured.daily[0].byModel, {});

// ---- totals / today：缓存和推理也要聚合 ----
//
// 概览页的「缓存命中率」= cachedTokens / promptTokens，缺了分子这一栏就算不出来。
//
// **`totals` 是「近 30 天」而不是全表**（2026-11-13 改的：账本一年 60 万行，全表
// `SUM` 会随时间长）。所以它是 350（窗口内三条）+ 999（20 天前那条）= 1349，
// 而 40 天前那 777 **不算**——这正是「窗口真的生效了」的判据。
check('总量窗口是 30 天', captured.window.days, 30);
check('总量窗口的起点是 30 个日历日之前', captured.window.since < RIGHT_NOW - 20 * DAY && captured.window.since > RIGHT_NOW - 40 * DAY, true);
check('totals.promptTokens（含 14 天外、30 天内）', captured.totals.promptTokens, 1349);
check('totals 不含 30 天以前的行', captured.totals.promptTokens === 1349 + 777, false);
check('totals.completionTokens', captured.totals.completionTokens, 50);
check('totals.tokens = 输入 + 输出', captured.totals.tokens, 1399);
check('totals.cachedTokens 被聚合', captured.totals.cachedTokens, 60);
check('totals.reasoningTokens 被聚合', captured.totals.reasoningTokens, 7);
check('byModel 也是 30 天窗口（m 的 token 不含 777）', captured.byModel.find((r) => r.model === 'm').tokens, 1399);
check('today.promptTokens 只算今天', captured.today.promptTokens, 100);
check('today.cachedTokens 只算今天', captured.today.cachedTokens, 60);

// ---- 按账号：卡片 2 读的就是这两个数组 ----
check('没有 account 的旧行归「(未标注)」', captured.todayByAccount.map((r) => r.account), ['(未标注)']);
check('byAccount 带 token 明细', captured.byAccount[0].tokens, 1399);
check('todayByAccount 的 promptTokens', captured.todayByAccount[0].promptTokens, 100);
// 查一个不存在的账号：`find` 返回 undefined，不该抛错（账号页会对已删账号查）。
const missing = captured.todayByAccount.find((row) => row.account === 'wb-1');
check('查一个不存在的账号不会崩', missing === undefined, true);

// ---- 追加后能读到新行 ----
//
// 进库之前这里钉的是「文件 size+mtime 变了没」的解析缓存。那个缓存已经删掉了：
// SQL 聚合一没有缓存要失效，二不会把行读进内存。判据只剩一条——**写完立刻能读到**。
const firstTotal = captured.totals.requests;
insertUsage({ ts: RIGHT_NOW, provider: 'workbuddy', model: 'm', credit: 9, promptTokens: 1000 });
const afterAppend = await usageSummary({ provider: 'workbuddy' });
check('插入一行后立刻能读到', afterAppend.totals.requests, firstTotal + 1);
check('追加的那行的积分也进来了', afterAppend.today.credits, 14);
check('追加的那行的 token 也进来了', afterAppend.today.tokens, 1120);

// ---- 「坏行跳过」那条断言已经删掉 ----
//
// 进库前账本要防「从字节中间切进去读到的半行 JSON」，那是 `MAX_READ_BYTES` 尾部读
// 带来的问题。SQLite 给不出半行：要么整行在，要么不在。这条断言不再有意义，
// 留着只会让人以为还有一条字节级的降级路径要维护。旧代码见 v4 之前的 `ledger.ts`。

// ---- 带 account 的行要进 byAccount ----
//
// 放在最后：前面几条断言都基于「追加前的原始计数」，这里一追加就会改计数，混在一起
// 会让那些断言变成看顺序的脆弱断言。
insertUsage({ ts: RIGHT_NOW, provider: 'workbuddy', model: 'm2', account: 'wb-1', credit: 4, promptTokens: 7, completionTokens: 3 });
const withAccount = await usageSummary({ provider: 'workbuddy' });
check('带 account 的行进 byAccount', withAccount.daily[13].byAccount['wb-1'], { tokens: 10, completionTokens: 3, requests: 1, credits: 4 });
check('带 account 的行同时进 byModel', withAccount.daily[13].byModel['m2'], { tokens: 10, completionTokens: 3, requests: 1, credits: 4 });
// 今天 workbuddy 一共三行：120/20、1000/0（追加测试）、7+3（这一行）。
check(
  'byProvider 把当天所有行都算进去',
  withAccount.daily[13].byProvider['workbuddy'],
  { tokens: 1130, completionTokens: 23, requests: 3, credits: 18 },
);
check('byAccount 里出现了 wb-1', withAccount.byAccount.map((r) => r.account).sort(), ['(未标注)', 'wb-1']);
check('wb-1 的累计 token', withAccount.byAccount.find((r) => r.account === 'wb-1').tokens, 10);

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
