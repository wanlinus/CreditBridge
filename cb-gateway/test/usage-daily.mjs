// `/api/usage` 的 daily 分桶：面板「近 14 天」柱状图读它，错一天/漏一天不报错只会让图悄悄变形。主口径是 token。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, section, done } from './_helpers.mjs';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-gw-usage-'));
process.env.QB_DATA_DIR = tempData;

const { insertUsage } = await import('../src/store/usage.ts');
const { usageSummary } = await import('../src/ledger.ts');

const RIGHT_NOW = Date.now();
const DAY = 86400000;
const records = [
  { ts: RIGHT_NOW, provider: 'workbuddy', model: 'm', credit: 5, promptTokens: 100, completionTokens: 20, cachedTokens: 60, reasoningTokens: 7 },
  { ts: RIGHT_NOW - DAY, provider: 'workbuddy', model: 'm', credit: 7, promptTokens: 200, completionTokens: 30 },
  { ts: RIGHT_NOW - 2 * DAY, provider: 'workbuddy', model: 'm', credit: null, promptTokens: 50 },
  { ts: RIGHT_NOW - 20 * DAY, provider: 'workbuddy', model: 'm', credit: 100, promptTokens: 999 },
  { ts: RIGHT_NOW - 40 * DAY, provider: 'workbuddy', model: 'm', credit: 500, promptTokens: 777 },
  { ts: RIGHT_NOW, provider: 'trae', model: 't', credit: 3, promptTokens: 111 },
];
for (const record of records) insertUsage(record);

const captured = await usageSummary({ provider: 'workbuddy' });

// 「今天」按北京时间算，和 ledger.ts 的 beijingToday + SQL `+8 hours` 同口径；本地 getDate() 在 UTC 进程会偏一天（2026-11-26 CI 红 14 项）。
const localDay = (ts) => {
  const shifted = new Date(ts + 8 * 3600000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
};

section('1. daily 分桶（近 14 天）');
const d = captured.daily;
check('固定 14 天', d.length, 14);
check('最后一天是今天（北京时间）', d[13].date, localDay(RIGHT_NOW));
check('今天/昨天/前天 token（100+20 / 200+30 / 只有输入 50）', [d[13].tokens, d[12].tokens, d[11].tokens], [120, 230, 50]);
check('没有输出的请求也算一次 requests', d[11].requests, 1);
check('空的一天补 0 而不是缺项', d[0].tokens, 0);
check('14 天以前不进数组（合计 400）', d.reduce((s, x) => s + x.tokens, 0), 400);
check('别的通道的 token 不算进来', d.some((x) => x.tokens === 111), false);
check('credits 如实透出', [d[13].credits, d.reduce((s, x) => s + x.credits, 0)], [5, 12]);

section('2. 柱内三维分桶（切维度只重画 SVG）');
const today = d[13];
check('byModel / byProvider', [today.byModel, today.byProvider], [
  { m: { tokens: 120, completionTokens: 20, requests: 1, credits: 5 } },
  { workbuddy: { tokens: 120, completionTokens: 20, requests: 1, credits: 5 } },
]);
check('旧行缺 account 归 (未标注)', today.byAccount, { '(未标注)': { tokens: 120, completionTokens: 20, requests: 1, credits: 5 } });
check('没 credit 的天照样进分桶（credits 0）', d[11].byModel, { m: { tokens: 50, completionTokens: 0, requests: 1, credits: 0 } });
check('空的一天的分桶是空对象', d[0].byModel, {});

section('3. 近 30 天总量窗口（不是全表）');
const t = captured.totals;
check('窗口是 30 天', captured.window.days, 30);
check('起点在 20~40 天之间', captured.window.since < RIGHT_NOW - 20 * DAY && captured.window.since > RIGHT_NOW - 40 * DAY, true);
// 窗口内三条(120+230+50=400) + 20 天前 999 = 1349 prompt；40 天前 777 不算——窗口真的生效了。
check('promptTokens 含 14 天外、30 天内', t.promptTokens, 1349);
check('不含 30 天以前的行', t.promptTokens === 1349 + 777, false);
check('completion / tokens（输入+输出）', [t.completionTokens, t.tokens], [50, 1399]);
check('cached / reasoning 被聚合', [t.cachedTokens, t.reasoningTokens], [60, 7]);
check('byModel 同 30 天窗口（m 不含 777）', captured.byModel.find((r) => r.model === 'm').tokens, 1399);
check('today 只算今天', [captured.today.promptTokens, captured.today.cachedTokens], [100, 60]);

section('4. 按账号与追加可见性');
check('旧行归 (未标注)', captured.todayByAccount.map((r) => r.account), ['(未标注)']);
check('byAccount 带 token 明细', [captured.byAccount[0].tokens, captured.todayByAccount[0].promptTokens], [1399, 100]);
check('查不存在的账号不崩', captured.todayByAccount.find((r) => r.account === 'wb-1') === undefined, true);

const firstTotal = captured.totals.requests;
insertUsage({ ts: RIGHT_NOW, provider: 'workbuddy', model: 'm', credit: 9, promptTokens: 1000 });
const afterAppend = await usageSummary({ provider: 'workbuddy' });
check('插入一行后立刻能读到', afterAppend.totals.requests, firstTotal + 1);
check('追加的 credit / token 也进来', [afterAppend.today.credits, afterAppend.today.tokens], [14, 1120]);

insertUsage({ ts: RIGHT_NOW, provider: 'workbuddy', model: 'm2', account: 'wb-1', credit: 4, promptTokens: 7, completionTokens: 3 });
const withAccount = await usageSummary({ provider: 'workbuddy' });
check('带 account 的行进 byAccount', withAccount.daily[13].byAccount['wb-1'], { tokens: 10, completionTokens: 3, requests: 1, credits: 4 });
check('带 account 的行同时进 byModel', withAccount.daily[13].byModel['m2'], { tokens: 10, completionTokens: 3, requests: 1, credits: 4 });
// 今天 workbuddy 三行：120/20、1000/0、7+3。
check('byProvider 把当天所有行都算进去', withAccount.daily[13].byProvider['workbuddy'], { tokens: 1130, completionTokens: 23, requests: 3, credits: 18 });
check('byAccount 出现 wb-1', withAccount.byAccount.map((r) => r.account).sort(), ['(未标注)', 'wb-1']);
check('wb-1 的累计 token', withAccount.byAccount.find((r) => r.account === 'wb-1').tokens, 10);

const { closeDb } = await import('../src/shared/db.ts');
closeDb();
fs.rmSync(tempData, { recursive: true, force: true });
done();
