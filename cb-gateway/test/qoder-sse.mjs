/**
 * Qoder SSE 传输层的回归测试。
 *
 * 覆盖两个文件：
 *   `sse.ts`      —— 分帧、解壳、头部过滤（与业务无关）
 *   `upstream.ts` —— 用量提取、字符闸、请求体构造
 *
 * ## 为什么这一套必须存在
 *
 * 上游每帧是「外层包内层」，`body` 是**字符串**，要再 parse 一次。壳里藏着三种
 * 非标准帧，漏一种就是**静默失败**：
 *
 * | 帧 | 漏了会怎样 |
 * |---|---|
 * | `body: "[DONE]"` | 结束时机错，客户端一直等 |
 * | 只有计时的帧 | 没有 body，当成 chunk 解析会抛错 → 整条流断 |
 * | 内层 `{code, message}` | **外层 HTTP 是 200**，当成正常 chunk → 用户看到空回复 |
 *
 * 第三种最危险：上游用「200 + 内层 403」表达签名错误，只看 HTTP 状态码会以为成功。
 *
 * ## 分帧为什么也要测
 *
 * 网络分片不保证按帧边界到达：一帧可能跨好几个 chunk，一个 chunk 也可能塞好几帧。
 * 这里用「把同一段数据按不同粒度切开喂进去」来验证缓冲逻辑。
 */
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

const sse = await import('../src/channels/qoder/sse.ts');
const upstream = await import('../src/channels/qoder/upstream.ts');
const { parseFrame, SseFrameSplitter, sanitizeHeaders } = sse;
const { usageOf, buildRequestBody, promptLimitOf } = upstream;

/* =================================================== 1. 解壳（最要紧） */

console.log('--- 1. parseFrame：四种帧形态 ---');

// ① 正常 chunk
const normal = JSON.stringify({
  headers: { 'Content-Type': ['application/json'] },
  body: JSON.stringify({
    choices: [{ delta: { content: 'hi', role: 'assistant' }, index: 0 }],
    created: 1,
    id: 'chatcmpl-x',
    model: 'auto',
    object: 'chat.completion.chunk',
  }),
  statusCodeValue: 200,
  statusCode: 'OK',
});
const f1 = parseFrame(normal);
check('正常帧 kind=chunk', f1.kind, 'chunk');
check('chunk 带 choices', Array.isArray(f1.chunk.choices));
check('delta 内容正确', f1.chunk.choices[0].delta.content, 'hi');

// ② [DONE]
check('[DONE] → kind=done', parseFrame(JSON.stringify({ body: '[DONE]' })).kind, 'done');
check('[DONE] 带空白也认', parseFrame(JSON.stringify({ body: ' [DONE] ' })).kind, 'done');

// ③ 计时段：没有 body
const f3 = parseFrame(JSON.stringify({ firstTokenDuration: 455, totalDuration: 1718, serverDuration: 46 }));
check('计时帧 kind=timing', f3.kind, 'timing');
check('计时帧带 firstTokenDuration', f3.timing.firstTokenDuration, 455);

// ④ 内层报错：外层 200 + 内层 403（最容易误判的一种）
const errorFrame = JSON.stringify({
  headers: { 'Content-Type': ['application/json'] },
  body: JSON.stringify({ code: '101', message: 'Signature invalid' }),
  statusCodeValue: 403,
  statusCode: 'FORBIDDEN',
});
const f4 = parseFrame(errorFrame);
check('内层错误 kind=error', f4.kind, 'error');
check('错误码正确', f4.code, '101');
check('错误文案正确', f4.message, 'Signature invalid');

// ⑤ 垃圾输入归 noise，不抛
check('空字符串 → noise', parseFrame('').kind, 'noise');
check('非 JSON → noise', parseFrame('not json').kind, 'noise');
check('不认识的外层 → noise', parseFrame(JSON.stringify({ foo: 1 })).kind, 'noise');
check('body 不是 JSON → noise', parseFrame(JSON.stringify({ body: 'not-json' })).kind, 'noise');

/* ==================================================== 2. 分帧 */

console.log('\n--- 2. SseFrameSplitter ---');
const frameA = 'data:{"n":1}';
const frameB = 'data:{"n":2}';

// 一次喂两帧
{
  const s = new SseFrameSplitter();
  check('一个 chunk 里两帧', s.push(`${frameA}\n\n${frameB}\n\n`), ['{"n":1}', '{"n":2}']);
}

// 逐字符喂：模拟最糟的网络分片
{
  const s = new SseFrameSplitter();
  const text = `${frameA}\n\n${frameB}\n\n`;
  const got = [];
  for (const ch of text) got.push(...s.push(ch));
  check('逐字符喂也能正确分帧', got, ['{"n":1}', '{"n":2}']);
}

// CRLF
{
  const s = new SseFrameSplitter();
  check('认 CRLF 分隔', s.push(`${frameA}\r\n\r\n${frameB}\r\n\r\n`), ['{"n":1}', '{"n":2}']);
}

// 半帧不该吐出来
{
  const s = new SseFrameSplitter();
  check('半帧不吐出', s.push('data:{"partial":true}'), []);
  check('补齐后吐出', s.push('\n\n'), ['{"partial":true}']);
}

// 非 data: 行忽略（心跳注释等）
{
  const s = new SseFrameSplitter();
  check('忽略非 data: 行', s.push(': keepalive\n\n'), []);
}

/* ==================================================== 3. 头部过滤 */

console.log('\n--- 3. sanitizeHeaders ---');
const sanitized = sanitizeHeaders({
  Host: 'x',
  Connection: 'keep-alive',
  'Content-Length': '999',
  Authorization: 'Bearer a',
  'Cosy-Key': '',
  'Cosy-Version': '1.0',
});
check('丢掉 host', 'host' in sanitized, false);
check('丢掉 connection', 'connection' in sanitized, false);
check('小写化保留 authorization', sanitized.authorization, 'Bearer a');
// 空 Cosy-Key 必须丢弃：发空串比不发更糟（上游会判签名无效）
check('丢弃空值头', 'cosy-key' in sanitized, false);
check('保留非空头', sanitized['cosy-version'], '1.0');
check('带 body 时补 content-length', sanitizeHeaders({}, 'abc')['content-length'], '3');

/* ============================================ 4. 用量（字段名必须下划线） */

console.log('\n--- 4. usageOf ---');
const u = usageOf({
  choices: [],
  usage: {
    billable: true,
    prompt_tokens: 95,
    completion_tokens: 79,
    total_tokens: 174,
    credits: 0.0064282459999999994,
    prompt_tokens_details: { cached_tokens: 0, cacheable_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 73 },
  },
});
// 这几条钉住字段名：写成驼峰类型上不报错，但账本读不到，
// 结果 usage_record.prompt_tokens 全 NULL、界面「今日 token」静默变 0。
check('prompt_tokens（下划线）', u.prompt_tokens, 95);
check('completion_tokens（下划线）', u.completion_tokens, 79);
check('total_tokens', u.total_tokens, 174);
check('cached_tokens', u.cached_tokens, 0);
check('credit', Math.round(u.credit * 10000) / 10000, 0.0064);
check('不带驼峰 promptTokens', 'promptTokens' in u, false);

check('没有 usage → null', usageOf({ choices: [] }), null);
check('usage 不是对象 → null', usageOf({ usage: 'x' }), null);

// 缺字段**不能写 0**——0 会被当成「这次真的用了 0 个 token」
const partial = usageOf({ usage: { credits: 1 } });
check('缺 prompt_tokens → 不写该 key', 'prompt_tokens' in partial, false);
check('缺 completion_tokens → 不写', 'completion_tokens' in partial, false);
check('缺 cached_tokens → 不写', 'cached_tokens' in partial, false);
check('缺 prompt 时不编造 total', 'total_tokens' in partial, false);
check('仍记下 credit', partial.credit, 1);

/* ================================================ 5. 请求体与字符闸 */

console.log('\n--- 5. 请求体 / 字符闸 ---');
const body = buildRequestBody(
  { model: 'x', messages: [{ role: 'user', content: 'hi' }], temperature: 0.5 },
  'Auto',
);
check('model 换成解析后的名字', body.model, 'Auto');
check('messages 原样带过去', body.messages.length, 1);
check('强制 stream', body.stream, true);
check('不透传 temperature', 'temperature' in body, false);

/* ================================== 6. tools 透传（2026-11-22 实测可用） */

console.log('\n--- 6. tools 透传 ---');
// 这一组钉住「不要把 tools 当不支持丢掉」。
// 实测：带 get_weather 定义时上游返回标准 tool_calls 增量帧、参数正确；
// 两个工具能正确二选一；tool_choice:'required' 能强制调用。
const TOOL = {
  type: 'function',
  function: { name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: {} } },
};
const withTools = buildRequestBody(
  { model: 'x', messages: [{ role: 'user', content: 'hi' }], tools: [TOOL], tool_choice: 'auto', parallel_tool_calls: false },
  'Auto',
);
check('tools 被透传', Array.isArray(withTools.tools) && withTools.tools.length, 1);
check('tool_choice 被透传', withTools.tool_choice, 'auto');
check('parallel_tool_calls 被透传', withTools.parallel_tool_calls, false);

// 没传时不该塞一堆 undefined 给上游
const withoutTools = buildRequestBody({ model: 'x', messages: [] }, 'Auto');
check('没传 tools 时不带该键', 'tools' in withoutTools, false);
check('没传 tool_choice 时不带该键', 'tool_choice' in withoutTools, false);
// 空数组也不带：上游对 tools:[] 的处理没验证过，别赌
const emptyTools = buildRequestBody({ model: 'x', messages: [], tools: [] }, 'Auto');
check('tools 是空数组时不带', 'tools' in emptyTools, false);

// 字符闸必须随窗口变化，不能写死
check('窗口 1M → 上限 150 万字符', promptLimitOf(1_000_000), 1_500_000);
check('窗口 200K → 上限 30 万', promptLimitOf(200_000), 300_000);
check('窗口 null → 回落 20 万', promptLimitOf(null), 200_000);
check('窗口 0 → 回落', promptLimitOf(0), 200_000);
check('窗口负数 → 回落', promptLimitOf(-1), 200_000);
// 这条钉住「窗口调大上限跟着涨」——反过来 DSH 会认为上下文还空着就被拒
check('窗口翻倍上限翻倍', promptLimitOf(400_000), 600_000);

/* ============================== 7. 上游错误的状态码翻译 */

console.log('\n--- 7. translateUpstreamError（状态码是给机器的接口）---');
// 2026-11-22 真实事故：上游回 {"code":"provider_error","message":"Error in upstream response"}，
// 我们一律包成 502。DSH 看到 502 当成「网关坏了」，而实际是上游瞬时抖了一下。
const t = upstream.translateUpstreamError;

// provider_error 是瞬态 → 503，明确告诉调用方「可以重试」
const transient = t('provider_error', 'Error in upstream response');
check('provider_error → 503', transient.status, 503);
check('provider_error 带 transient 标记', transient.code, 'qoder_upstream_transient');

// 登录失效 → 401：**有副作用地正确**，账号层会把号标成 invalid
const expired = t('105', 'Login expired');
check('code 105 → 401', expired.status, 401);
check('105 带 login_expired 标记', expired.code, 'qoder_login_expired');

// 签名算错是**我们**的 bug，不能误标账号失效（所以不是 401）
const sig = t('101', 'Signature invalid');
check('Signature invalid → 502（不误标账号失效）', sig.status, 502);
check('签名错误带专用 code', sig.code, 'qoder_signature_rejected');

// 未知错误兜底 502
const unknown = t('9999', 'something odd');
check('未知错误 → 502', unknown.status, 502);

// 文案里带 login expired 的字符串码也要认（上游码风格不统一）
const strExpired = t('some_string', 'Login expired, please re-login');
check('字符串码 + 文案含 Login expired → 401', strExpired.status, 401);

console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
