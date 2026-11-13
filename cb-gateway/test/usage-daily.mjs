import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-gw-usage-'));
process.env.QB_DATA_DIR = tempData;

const RIGHT_NOW = Date.now();
const DAY = 86400000;
const records = [
  { ts: RIGHT_NOW, provider: 'workbuddy', model: 'm', credit: 5, promptTokens: 100, completionTokens: 20, cachedTokens: 60, reasoningTokens: 7 },
  { ts: RIGHT_NOW - DAY, provider: 'workbuddy', model: 'm', credit: 7, promptTokens: 200, completionTokens: 30 },
  { ts: RIGHT_NOW - 2 * DAY, provider: 'workbuddy', model: 'm', credit: null, promptTokens: 50 },
  { ts: RIGHT_NOW - 20 * DAY, provider: 'workbuddy', model: 'm', credit: 100, promptTokens: 999 },
  { ts: RIGHT_NOW, provider: 'trae', model: 't', credit: 3, promptTokens: 111 },
];
fs.writeFileSync(path.join(tempData, 'usage.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');

const { usageSummary } = await import('../src/ledger.ts');

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

check('daily 固定 14 天', captured.daily.length, 14);
check('最后一天是今天（按本地日历日）', captured.daily[13].date, localDay(RIGHT_NOW));
check('今天的 token（100 + 20）', captured.daily[13].tokens, 120);
check('昨天的 token（200 + 30）', captured.daily[12].tokens, 230);
check('只有输入时也照算', captured.daily[11].tokens, 50);
check('14 天以前的 tokens 不进数组', captured.daily.reduce((sum, d) => sum + d.tokens, 0), 400);
check('别的通道的 token 不算进来', captured.daily.some((d) => d.tokens === 111), false);
check('没有输出的请求也算一次 requests', captured.daily[11].requests, 1);
check('空的一天补 0 而不是缺项', captured.daily[0].tokens, 0);

check('今天的 credits 仍然记着', captured.daily[13].credits, 5);
check('窗口内 credits 合计', captured.daily.reduce((sum, d) => sum + d.credits, 0), 12);

check('今天的 byModel', captured.daily[13].byModel, { m: { tokens: 120, completionTokens: 20, requests: 1, credits: 5 } });
check('今天的 byProvider', captured.daily[13].byProvider, { workbuddy: { tokens: 120, completionTokens: 20, requests: 1, credits: 5 } });
check('旧行没有 account → 归「(未标注)」', captured.daily[13].byAccount, { '(未标注)': { tokens: 120, completionTokens: 20, requests: 1, credits: 5 } });
check('没有 credit 的那天照样进分桶（credits 0）', captured.daily[11].byModel, { m: { tokens: 50, completionTokens: 0, requests: 1, credits: 0 } });
check('空的一天的分桶是空对象，不是缺键', captured.daily[0].byModel, {});

check('totals.promptTokens（含窗口外）', captured.totals.promptTokens, 1349);
check('totals.completionTokens', captured.totals.completionTokens, 50);
check('totals.tokens = 输入 + 输出', captured.totals.tokens, 1399);
check('totals.cachedTokens 被聚合', captured.totals.cachedTokens, 60);
check('totals.reasoningTokens 被聚合', captured.totals.reasoningTokens, 7);
check('today.promptTokens 只算今天', captured.today.promptTokens, 100);
check('today.cachedTokens 只算今天', captured.today.cachedTokens, 60);

check('没有 account 的旧行归「(未标注)」', captured.todayByAccount.map((r) => r.account), ['(未标注)']);
check('byAccount 带 token 明细', captured.byAccount[0].tokens, 1399);
check('todayByAccount 的 promptTokens', captured.todayByAccount[0].promptTokens, 100);
const missing = captured.todayByAccount.find((row) => row.account === 'wb-1');
check('查一个不存在的账号不会崩', missing === undefined, true);

const firstTotal = captured.totals.requests;
fs.appendFileSync(
  path.join(tempData, 'usage.jsonl'),
  JSON.stringify({ ts: RIGHT_NOW, provider: 'workbuddy', model: 'm', credit: 9, promptTokens: 1000 }) + '\n',
);
const afterAppend = await usageSummary({ provider: 'workbuddy' });
check('追加一行后立刻能读到（缓存按 size+mtime 失效）', afterAppend.totals.requests, firstTotal + 1);
check('追加的那行的积分也进来了', afterAppend.today.credits, 14);
check('追加的那行的 token 也进来了', afterAppend.today.tokens, 1120);

const mixed = path.join(tempData, 'usage.jsonl');
fs.appendFileSync(mixed, '{"ts":123,这不是合法JSON\n');
fs.appendFileSync(mixed, JSON.stringify({ ts: RIGHT_NOW, provider: 'workbuddy', model: 'm', credit: 1, promptTokens: 5 }) + '\n');
const afterCorrupt = await usageSummary({ provider: 'workbuddy' });
check('半行坏 JSON 被跳过，不让整页统计消失', afterCorrupt.totals.requests, afterAppend.totals.requests + 1);

fs.appendFileSync(
  path.join(tempData, 'usage.jsonl'),
  JSON.stringify({ ts: RIGHT_NOW, provider: 'workbuddy', model: 'm2', account: 'wb-1', credit: 4, promptTokens: 7, completionTokens: 3 }) + '\n',
);
const withAccount = await usageSummary({ provider: 'workbuddy' });
check('带 account 的行进 byAccount', withAccount.daily[13].byAccount['wb-1'], { tokens: 10, completionTokens: 3, requests: 1, credits: 4 });
check('带 account 的行同时进 byModel', withAccount.daily[13].byModel['m2'], { tokens: 10, completionTokens: 3, requests: 1, credits: 4 });
check(
  'byProvider 把当天所有行都算进去',
  withAccount.daily[13].byProvider['workbuddy'],
  { tokens: 1135, completionTokens: 23, requests: 4, credits: 19 },
);
check('byAccount 里出现了 wb-1', withAccount.byAccount.map((r) => r.account).sort(), ['(未标注)', 'wb-1']);
check('wb-1 的累计 token', withAccount.byAccount.find((r) => r.account === 'wb-1').tokens, 10);

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
