// Loomy 的「这次请求贵不贵」日志行。
//
// 钉住 2026-11-22 那次事故：一次 69 万 token 的全新请求花掉 1720 分（当天额度 5000），
// 而日志里只有 `chat done ... 142084ms` —— **看不出钱花在哪**。
//
// 根因不是网关算错账（账本 2989 分和上游一致），而是：
// Loomy 用前缀缓存，**首次出现的内容必然全价**。「一次性塞几十万 token 全新内容」
// 和「在已有对话上追加一句」成本差几十倍，但这两件事在日志里长得一模一样。
//
// 所以这里钉三件事：
//   1. 有缓存字段时，必须把 prompt / cached / uncached / hit 都打出来；
//   2. 命中率低时要有明确警告（正常多轮对话在 95% 上下）；
//   3. 上游没报缓存字段时**不许编造命中率**——「不知道」和「命中 0%」是两件事。
//
// 跑：node test/loomy-usage-log.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-loomy-log-'));
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

// 日志通过 setLoomyUpstreamLogger 注入，直接截获它——比去读日志文件可靠，也不依赖落盘时机。
const logs = [];
const upstream = await import('../src/channels/loomy/upstream.ts');
const auth = await import('../src/channels/loomy/auth.ts');
upstream.setLoomyUpstreamLogger((line) => logs.push(line));
auth.setLoomyLogger((line) => logs.push(line));

/**
 * 造一个最小的 SSE 响应，喂给 chatLoomy。
 *
 * 必须真的走一遍 chatLoomy 而不是直接调 finishedLine()：后者没导出，
 * 而且「日志行是在流结束时打的」这件事本身也值得钉住（曾经有个 bug 是
 * 流结束但 finally 没跑到）。
 */
function sseResponse(usageChunk) {
  const frames = [
    { id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'OK' } }] },
    { id: 'x', object: 'chat.completion.chunk', choices: [], usage: usageChunk },
  ];
  const body = `${frames.map((f) => `data: ${JSON.stringify(f)}`).join('\n\n')}\n\ndata: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const account = {
  id: 'lo-9',
  channelId: 'loomy',
  status: 'ready',
  credential: {
    session: 'fake-session-for-test',
    uid: 'u-test',
    username: '测试号',
    domain: 'loomy.xunfei.cn',
    tokenExpiresAt: new Date(Date.now() + 86400_000).toISOString(),
    savedAt: Date.now(),
  },
};

let nextUsage = null;
globalThis.fetch = async () => sseResponse(nextUsage);

async function runWith(usage) {
  logs.length = 0;
  nextUsage = usage;
  const outcome = await upstream.chatLoomy(account, {
    body: { model: 'DeepSeek-V4.1-Flash', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    signal: null,
    onUsage: () => {},
  });
  // 必须把流读干净，finally 才会跑、日志才会出。
  if (outcome.body && typeof outcome.body[Symbol.asyncIterator] === 'function') {
    for await (const _ of outcome.body) void _;
  } else if (outcome.body && typeof outcome.body.getReader === 'function') {
    const reader = outcome.body.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  }
  return logs.find((l) => l.includes('chat done')) ?? '';
}

// ---- 1. 正常多轮对话：命中率高，不打警告 ----
console.log('--- 1. 高命中（正常多轮对话）---');
let line = await runWith({
  prompt_tokens: 100000,
  completion_tokens: 500,
  total_tokens: 100500,
  prompt_tokens_details: { cached_tokens: 96000 },
  points_consumed: 12,
});
check('打出 prompt', /prompt=100000/.test(line), true);
check('打出 cached', /cached=96000/.test(line), true);
check('打出 uncached（这是「全价部分」）', /uncached=4000/.test(line), true);
check('打出命中率', /hit=96\.0%/.test(line), true);
check('打出积分', /credit=12/.test(line), true);
check('高命中不告警', /⚠️/.test(line), false);

// ---- 2. 事故场景：69 万 token 全新内容 ----
console.log('\n--- 2. 低命中（2026-11-22 那次事故）---');
line = await runWith({
  prompt_tokens: 693646,
  completion_tokens: 614,
  total_tokens: 694260,
  prompt_tokens_details: { cached_tokens: 8832 },
  points_consumed: 1720,
});
check('打出 uncached=684814', /uncached=684814/.test(line), true);
check('命中率 1.3%', /hit=1\.3%/.test(line), true);
check('低命中必须告警', /⚠️/.test(line), true);
check('告警说明「按全价计费」', /全价/.test(line), true);

// ---- 3. 上游没报缓存字段：不许编造 ----
console.log('\n--- 3. 上游没报缓存字段 ---');
line = await runWith({
  prompt_tokens: 29,
  completion_tokens: 16,
  total_tokens: 45,
  points_consumed: 1,
});
check('打出 prompt', /prompt=29/.test(line), true);
check('不编造 cached', /cached=/.test(line), false);
check('不编造命中率', /hit=/.test(line), false);
check('不误报低命中警告', /⚠️/.test(line), false);

// ---- 4. 完全没有 usage：仍然要有结束日志 ----
console.log('\n--- 4. 没有 usage（异常兜底）---');
line = await runWith(null);
check('仍有 chat done 行', /chat done/.test(line), true);
check('不含 token 字段', /prompt=/.test(line), false);

// 先关库再删临时目录：Windows 上删不掉被打开的文件。
const { closeDb } = await import('../src/shared/db.ts');
closeDb();
fs.rmSync(tempData, { recursive: true, force: true });
console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
