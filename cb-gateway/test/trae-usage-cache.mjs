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

const piAiCacheRead = (usage) =>
  usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? usage.cached_tokens ?? 0;
const piAiCacheWrite = (usage) => usage.prompt_tokens_details?.cache_write_tokens || 0;

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

const input = Math.max(0, mapped.prompt_tokens - piAiCacheRead(mapped) - piAiCacheWrite(mapped));
check('账目守恒（input + 命中 + 写入 = prompt_tokens）', input + piAiCacheRead(mapped) + piAiCacheWrite(mapped), mapped.prompt_tokens);
check('命中量是子集，不会被算成额外增量', input, 8);

check('原样透传原生字段名时 pi-ai 读不到（所以必须映射）', piAiCacheRead({ prompt_tokens: 9224, cache_read_input_tokens: 9216 }), 0);

const noCache = mapTraeTokenUsage({ prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 });
check('上游没给缓存字段时不产生 prompt_tokens_details', noCache.prompt_tokens_details === undefined);
check('「没报」和「报了 0」是两件事', piAiCacheRead(noCache), 0);

check('null 不抛', mapTraeTokenUsage(null), null);
check('数组不抛（spread 会把它变成 {"0":1}）', mapTraeTokenUsage([1, 2]), null);
check('计数类型不对就整个不收（宁可说不知道）', mapTraeTokenUsage({ prompt_tokens: '9224' }), null);
check(
  '负的命中量当成「没说」',
  mapTraeTokenUsage({ prompt_tokens: 100, completion_tokens: 1, total_tokens: 101, cache_read_input_tokens: -5 }).prompt_tokens_details === undefined,
);

ledger.recordChatUsage(mapped, 'glm-5.3', undefined, Date.now(), 200, 'trae', 'tr-1');
ledger.recordChatUsage(noCache, 'glm-5.3', undefined, Date.now(), 200, 'trae', 'tr-1');
const lines = fs
  .readFileSync(path.join(tempData, 'usage.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
check('账本记了缓存命中', lines[0].cachedTokens, 9216);
check('账本记了缓存写入', lines[0].cacheWriteTokens, 0);
check('上游没报时账本记 null，不记 0', lines[1].cachedTokens, null);

const source = fs.readFileSync(new URL('../src/channels/trae/upstream.ts', import.meta.url), 'utf8');
check('token_usage 分支接了 mapTraeTokenUsage', /event === 'token_usage'[\s\S]{0,400}?mapTraeTokenUsage\(data\)/.test(source));

fs.rmSync(tempData, { recursive: true, force: true });
console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
