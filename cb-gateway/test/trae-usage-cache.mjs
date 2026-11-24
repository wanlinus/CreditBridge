// Trae 的 usage 缓存字段：上游字段名 → pi-ai 认得的 OpenAI 拼写。
//
// 为什么值得单独一套：这个缺口**不会报错**。上游照常回报 `cache_read_input_tokens`，
// 网关也照常把 usage 转出去，只是字段名不在 pi-ai 认的三个拼写里，于是 DSH 界面的
// 「缓存命中」恒为 0——看起来像上游没缓存，实际是中间这一层把字段名丢了。
// 第 1 组用例里的 payload 是**真实捕获的原文**（同类实现 dsh-connect-trae 的
// docs/ISSUE10_DIAGNOSIS.md，MIT 许可），不是我们自己编的。
//
// 跑：node test/trae-usage-cache.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-trae-usage-cache-'));
process.env.QB_DATA_DIR = tempData;

const { mapTraeTokenUsage } = await import('../src/channels/trae/upstream.ts');
const ledger = await import('../src/ledger.ts');

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

/**
 * pi-ai 的 `parseChunkUsage` 怎么读缓存（逐字照搬它认的三种拼写）。
 *
 * 断言必须走**它的**取法，不能用我们自己的字段假设去测——否则两边一起漂，
 * 「测试通过」只证明我们自洽。
 */
const piAiCacheRead = (usage) =>
  usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? usage.cached_tokens ?? 0;
const piAiCacheWrite = (usage) => usage.prompt_tokens_details?.cache_write_tokens || 0;

// ---- 1. 真实 payload（2026-09 捕获，同一份 prompt 的第三次请求）----
const REAL = {
  name: '',
  prompt_tokens: 9224,
  completion_tokens: 173,
  total_tokens: 9397,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 9216,
  reasoning_tokens: 171,
  prompt_tokens_total: 0,
  completion_tokens_total: 0,
  total_tokens_total: 0,
  cache_creation_input_tokens_total: 0,
  cache_read_input_tokens_total: 0,
  reasoning_tokens_total: 0,
  cluster: 'normal_context',
};

const mapped = mapTraeTokenUsage(REAL);
check('缓存读取量映射成 pi-ai 认的拼写', piAiCacheRead(mapped), 9216);
check('缓存写入量同样映射（上游报 0 就记 0）', mapped.prompt_tokens_details.cache_write_tokens, 0);
check('reasoning_tokens 仍在', mapped.completion_tokens_details.reasoning_tokens, 171);
check('三个计数一个不少', [mapped.prompt_tokens, mapped.completion_tokens, mapped.total_tokens], [9224, 173, 9397]);

// 账目守恒：pi-ai 会做 `input = prompt_tokens - cacheRead - cacheWrite`。
const input = Math.max(0, mapped.prompt_tokens - piAiCacheRead(mapped) - piAiCacheWrite(mapped));
check('账目守恒（input + 命中 + 写入 = prompt_tokens）', input + piAiCacheRead(mapped) + piAiCacheWrite(mapped), mapped.prompt_tokens);
check('命中量是子集，不会被算成额外增量', input, 8);

// ---- 2. 反例守卫：只做「放行」是不够的 ----
// 把上游原生字段名原样透传，pi-ai 读到的是 0。这条钉的是「必须做字段名映射」这个结论，
// 而不是「我们映射得对」——两种修法都像模像样，只有这条能区分。
check('原样透传原生字段名时 pi-ai 读不到（所以必须映射）', piAiCacheRead({ prompt_tokens: 9224, cache_read_input_tokens: 9216 }), 0);

// ---- 3. 上游没报就不产生字段 ----
const noCache = mapTraeTokenUsage({ prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 });
check('上游没给缓存字段时不产生 prompt_tokens_details', noCache.prompt_tokens_details === undefined);
check('「没报」和「报了 0」是两件事', piAiCacheRead(noCache), 0);

// ---- 4. 坏形状不炸、也不当 0 ----
check('null 不抛', mapTraeTokenUsage(null), null);
check('数组不抛（spread 会把它变成 {"0":1}）', mapTraeTokenUsage([1, 2]), null);
check('计数类型不对就整个不收（宁可说不知道）', mapTraeTokenUsage({ prompt_tokens: '9224' }), null);
check(
  '负的命中量当成「没说」',
  mapTraeTokenUsage({ prompt_tokens: 100, completion_tokens: 1, total_tokens: 101, cache_read_input_tokens: -5 }).prompt_tokens_details === undefined,
);

// ---- 5. 账本真的落了两列 ----
ledger.recordChatUsage(mapped, 'glm-5.3', undefined, Date.now(), 200, 'trae', 'tr-1');
ledger.recordChatUsage(noCache, 'glm-5.3', undefined, Date.now(), 200, 'trae', 'tr-1');
// v4 B 阶段起账本只在库里（不再写 `usage.jsonl`），所以这里读库。
const { usageRecent } = await import('../src/store/usage.ts');
const lines = [...usageRecent({ provider: 'trae' }, 10).ok].reverse();
check('账本记了缓存命中', lines[0].cachedTokens, 9216);
check('账本记了缓存写入', lines[0].cacheWriteTokens, 0);
check('上游没报时账本记 null，不记 0', lines[1].cachedTokens, null);

// ---- 6. 接线守卫 ----
// `translate` 是 `chatTrae` 里的闭包，起不了单测；而「映射函数写对了、却没人调它」
// 是一个会静默的缺口——界面缓存恒 0，跟「上游没缓存」长得一模一样。
// 这里只断言 `token_usage` 分支确实走了映射函数。**它只是个哨兵**，不能替代
// 「真发一次对话、看 DSH 里缓存命中是否为非 0」那条端到端验证。
const source = fs.readFileSync(new URL('../src/channels/trae/upstream.ts', import.meta.url), 'utf8');
check('token_usage 分支接了 mapTraeTokenUsage', /event === 'token_usage'[\s\S]{0,400}?mapTraeTokenUsage\(data\)/.test(source));

// 先关库再删临时目录：Windows 上删不掉一个被打开的文件（EPERM）。
const { closeDb } = await import('../src/shared/db.ts');
closeDb();
fs.rmSync(tempData, { recursive: true, force: true });
console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
