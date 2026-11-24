// Qoder 对话传输层：上游内层就是标准 OpenAI SSE，这里只解外层壳、原样转发。
// 坑：上游把用量**分多帧**报、各帧字段不全，必须 `mergeUsage` 合并而不是覆盖
// （覆盖会把 `credit` 冲成 undefined，账单里积分变 0）。

import https from 'node:https';
import http from 'node:http';

import type { Account, ChatOutcome, ChatRequest, ChatUsage } from '../../types.ts';
import { asCredentialError } from '../../shared/credential-error.ts';
import { UpstreamError } from '../../shared/upstream-error.ts';
import { resolveSignatureUserInfo, signChatRequest, signRestRequest, decryptServerResponse } from './cosy/sign.ts';
import { effectiveContextWindowOf, getModelNames, maybeRefreshAfterChat, resolveModelName, setModelNameSource } from './models.ts';
import { SseFrameSplitter, parseFrame, sanitizeHeaders, type HttpRequestSpec, type UpstreamFrame } from './sse.ts';

/** 模型列表接口。`Encode=1` 让它返回可读 JSON 而不是压缩串。 */
const MODEL_LIST_PATH = '/algo/api/v2/model/list?Encode=1';

/** 兜底 prompt 字符上限，只在拿不到模型窗口时用。实测送 200 万字符上游不报错、正常返回、扣 14 credits。 */
const FALLBACK_PROMPT_CHARS = 200_000;

/**
 * 1 token 折几个字符，**往小了取**（中文约 1.5，英文约 4）：折算出的字符数越少闸门越紧。
 * 必须和上报给 DSH 的窗口同源，否则 DSH 认为上下文还空着、请求直接被拒。
 */
const CHARS_PER_TOKEN = 1.5;

const UPSTREAM_TIMEOUT_MS = 180_000;

const REST_TIMEOUT_MS = 30_000;

/**
 * 真正透传给上游的字段。`tools` 三件套 2026-11-22 实测可用，缺了模型只能靠文本「假装」调工具。
 * 教训：proto 有字段 ≠ HTTP 端点支持，两种方向都得实测。
 */
const SUPPORTED_PARAMS = ['model', 'messages', 'stream', 'tools', 'tool_choice', 'parallel_tool_calls'];

/**
 * 上游可能支持但没验证过的字段：一律「忽略并记日志」，**不假装生效**。要接先实测再挪进 `SUPPORTED_PARAMS`。
 * `max_completion_tokens`（`max_tokens` 的新名）上游两个都不认，但传了也不报错。
 */
const IGNORED_PARAMS = [
  'temperature', 'top_p', 'stop', 'frequency_penalty', 'presence_penalty',
  'max_tokens', 'max_completion_tokens', 'n', 'seed', 'logit_bias', 'response_format',
  'user', 'store', 'metadata', 'service_tier', 'stream_options', 'logprobs', 'top_logprobs',
  'modalities', 'prediction', 'reasoning_effort',
];

let logSink: any = null;

export function setUpstreamLogger(fn: any): void {
  logSink = fn;
}

function log(...args: unknown[]): void {
  if (logSink) logSink(`[qoder-upstream] ${args.join(' ')}`);
}

export function promptLimitOf(contextWindow: number | null): number {
  if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0) return FALLBACK_PROMPT_CHARS;
  return Math.floor(contextWindow * CHARS_PER_TOKEN);
}

function countPromptChars(messages: any[]): number {
  let total = 0;
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const content = message.content;
    if (typeof content === 'string') {
      total += content.length;
      continue;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === 'object' && typeof part.text === 'string') total += part.text.length;
      }
    }
  }
  return total;
}

/** 从内层 chunk 里取用量。字段名必须是**下划线**的 `ChatUsage` 形状：写成驼峰（`promptTokens`）类型不报错，但账本读不到值，表现是 `usage_record.prompt_tokens` 全 NULL、界面 token 静默变 0。
 * 缺字段就不写这个 key——写 0 等于把「不知道」说成「就是 0」。 */
export function usageOf(chunk: any): ChatUsage | null {
  const u = chunk?.usage;
  if (!u || typeof u !== 'object') return null;

  const promptTokens = Number(u.prompt_tokens);
  const completionTokens = Number(u.completion_tokens);
  const cached = Number(u.prompt_tokens_details?.cached_tokens);
  const credit = Number(u.credits);

  const usage: ChatUsage = {};
  if (Number.isFinite(promptTokens)) usage.prompt_tokens = promptTokens;
  if (Number.isFinite(completionTokens)) usage.completion_tokens = completionTokens;
  if (Number.isFinite(promptTokens) && Number.isFinite(completionTokens)) {
    usage.total_tokens = promptTokens + completionTokens;
  }
  if (Number.isFinite(credit)) usage.credit = credit;
  // 缓存是 prompt 的**子集**，单独一个键
  if (Number.isFinite(cached)) usage.cached_tokens = cached;

  return Object.keys(usage).length > 0 ? usage : null;
}

/**
 * 合并用量：**只补缺失，不覆盖已有**。上游可能一帧给 token、另一帧给 credits，
 * 直接赋值会让后一帧把 `credit` 覆盖掉，表现是账单里积分变 0。
 */
function mergeUsage(prev: ChatUsage | null, next: ChatUsage | null): ChatUsage | null {
  if (!next) return prev;
  if (!prev) return next;
  const merged: ChatUsage = { ...prev };
  for (const [key, value] of Object.entries(next)) {
    if (value !== null && value !== undefined) merged[key] = value;
  }
  return merged;
}

function usageToOpenAI(usage: ChatUsage | null): any {
  if (!usage) return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const prompt = Number(usage.prompt_tokens ?? 0);
  const completion = Number(usage.completion_tokens ?? 0);
  const cached = usage.cached_tokens;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(typeof cached === 'number' ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
  };
}

function openSignedStream(
  spec: HttpRequestSpec,
  handlers: {
    onFrame: (frame: UpstreamFrame) => void;
    onEnd: () => void;
    onError: (error: Error) => void;
  },
  signal?: AbortSignal,
): void {
  const url = new URL(spec.url);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  const req = transport.request(
    {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: sanitizeHeaders(spec.headers, spec.body),
      timeout: UPSTREAM_TIMEOUT_MS,
    },
    (res) => {
      if (res.statusCode !== 200) {
        let detail = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          detail += c;
        });
        res.on('end', () => {
          handlers.onError(
            new UpstreamError(502, `上游返回 HTTP ${res.statusCode}：${detail.slice(0, 300)}`, {
              code: 'qoder_http_error',
            }),
          );
        });
        return;
      }

      const splitter = new SseFrameSplitter();
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        for (const payload of splitter.push(chunk)) handlers.onFrame(parseFrame(payload));
      });
      res.on('end', () => handlers.onEnd());
      res.on('error', (e) => handlers.onError(e));
    },
  );

  // **客户端断开就掐上游**，否则用户关掉对话后网关还在往没人收的流里读，白烧额度。
  const abort = () => {
    req.destroy();
    handlers.onError(new UpstreamError(499, '客户端已断开', { code: 'qoder_client_aborted' }));
  };
  if (signal) {
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    req.on('close', () => signal.removeEventListener('abort', abort));
  }

  req.on('error', (e) => handlers.onError(e));
  req.on('timeout', () => {
    req.destroy();
    handlers.onError(new UpstreamError(504, `上游超时（${UPSTREAM_TIMEOUT_MS / 1000} 秒没有响应）`, { code: 'qoder_timeout' }));
  });
  req.end(spec.body ?? '');
}

async function fetchSignedText(spec: HttpRequestSpec, signal?: AbortSignal): Promise<string> {
  const url = new URL(spec.url);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  return await new Promise<string>((resolve, reject) => {
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers: sanitizeHeaders(spec.headers),
        timeout: REST_TIMEOUT_MS,
        signal,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(
              new UpstreamError(502, `HTTP ${res.statusCode}：${data.slice(0, 200)}`, { code: 'qoder_rest_http_error' }),
            );
            return;
          }
          resolve(data);
        });
      },
    );
    req.on('error', (e) => reject(e));
    req.on('timeout', () => {
      req.destroy();
      reject(new UpstreamError(504, '请求超时', { code: 'qoder_rest_timeout' }));
    });
    req.end();
  });
}

/**
 * 从上游取模型列表原始文档（`chat` 数组里每项带 `key` / `display_name` / `price_factor` / `context_config`）。
 * 上游可能把响应体再包一层密文，解不开就按明文用。
 */
async function fetchModelListDocument(account: Account): Promise<any> {
  const userInfo = await resolveSignatureUserInfo(account);
  const signed = await signRestRequest(userInfo, MODEL_LIST_PATH, 'GET', 'auth');
  const body = await fetchSignedText(signed);

  let doc: any;
  try {
    doc = JSON.parse(body);
  } catch {
    throw new UpstreamError(502, `模型列表返回的不是 JSON：${body.slice(0, 200)}`, { code: 'qoder_models_bad_json' });
  }

  if (typeof doc === 'string') {
    const decrypted = await decryptServerResponse(doc);
    try {
      doc = JSON.parse(decrypted);
    } catch {
      throw new UpstreamError(502, '模型列表响应是加密的但解密失败', { code: 'qoder_models_undecryptable' });
    }
  }
  return doc;
}

/**
 * 给 `models.ts` 注入「怎么取模型名单」。依赖方向是 `upstream → models`（对话要用模型窗口），
 * 所以取数放在这边、由 `index.ts` 在 `configure()` 接到账号层——反过来 import 会成环。
 */
export function setQoderModelSource(resolver: () => Promise<Account | null>): void {
  setModelNameSource(async () => {
    const account = await resolver();
    if (!account) {
      throw new UpstreamError(401, '取模型名单需要一个可用的 Qoder 账号', { code: 'qoder_no_account' });
    }
    const doc = await fetchModelListDocument(account);
    const chat = Array.isArray(doc?.chat) ? doc.chat : [];
    const names = chat
      .map((m: any) => (typeof m?.display_name === 'string' && m.display_name !== '' ? m.display_name : m?.key))
      .filter((name: any): name is string => typeof name === 'string' && name !== '');
    if (names.length === 0) {
      throw new UpstreamError(502, '模型列表接口没有返回任何模型', { code: 'qoder_models_empty' });
    }
    return names;
  });
}

/** 把上游错误帧翻译成 `UpstreamError`，**按上游 code 定状态码**：上游用「HTTP 200 + 内层 `{code, message}`」表达失败，一律 502 会让 DSH 把上游抖动当成网关坏了、或者令牌过期了还一直重试。
 * 登录失效映射成 401 是有副作用的正确行为（账号层会因此标 `invalid`），不是顺手。 */
export function translateUpstreamError(code: string, message: string): UpstreamError {
  const numeric = Number(code);

  // 105 = Login expired；101 = Signature invalid
  if (numeric === 105 || /login (expired|required|invalid)/i.test(message)) {
    return new UpstreamError(401, `Qoder 登录已失效：${message}（上游 code ${code}），请重新登录`, {
      code: 'qoder_login_expired',
    });
  }
  if (/signature invalid/i.test(message)) {
    // 签名算错是**我们**的问题，重试无用；502 而不是 401，免得误标账号失效
    return new UpstreamError(502, `Qoder 签名被拒：${message}（上游 code ${code}）。这通常是网关侧的 bug`, {
      code: 'qoder_signature_rejected',
    });
  }
  if (/provider_error|upstream|internal|timeout|overload|busy/i.test(code + ' ' + message)) {
    // 瞬态：503 明确告诉调用方「稍后重试」，而且不会污染账号状态
    return new UpstreamError(503, `Qoder 上游暂时不可用：${message}（上游 code ${code}），稍后重试`, {
      code: 'qoder_upstream_transient',
    });
  }
  return new UpstreamError(502, `上游拒绝：${message}（code ${code}）`, { code: 'qoder_upstream_rejected' });
}

/**
 * 构造发给上游的 body。`messages` 和 `tools` 三件套原样透传（见 `SUPPORTED_PARAMS`）。
 * `stream` 恒为 true——上游只支持流式，非流式由本地读完再拼。
 */
export function buildRequestBody(payload: any, model: string): any {
  const body: any = { model, stream: true, messages: payload.messages };

  // 只在客户端真的传了才带，避免给上游塞一堆 undefined
  if (Array.isArray(payload.tools) && payload.tools.length > 0) body.tools = payload.tools;
  if (payload.tool_choice !== undefined) body.tool_choice = payload.tool_choice;
  if (typeof payload.parallel_tool_calls === 'boolean') body.parallel_tool_calls = payload.parallel_tool_calls;

  return body;
}

function completionId(): string {
  return `chatcmpl-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/**
 * 通道的对话入口。
 * @param prefix 账号 id 前缀（`qd`），用于查 `/models` 页配的窗口；元数据只有一份，不在这里写死。
 */
export async function chatQoder(account: Account, request: ChatRequest, prefix: string): Promise<ChatOutcome> {
  const payload = request.body;
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  if (messages.length === 0) {
    throw new UpstreamError(400, 'messages 不能为空', { code: 'qoder_empty_messages' });
  }

  const model = await resolveModel(payload.model);

  // 字符闸**必须在这里拦**：上游对超长输入不报错，会照常跑完并扣大量积分。
  // 窗口同时给字符闸和 `/v1/models` 用，两处必须同源，否则 DSH 认为上下文还空着就会被拒。
  const contextWindow = effectiveContextWindowOf(prefix, model);
  const limit = promptLimitOf(contextWindow);
  const promptChars = countPromptChars(messages);
  if (promptChars > limit) {
    // 文案别写「截断」：这里是**整条拒绝**，一个字都没发给上游。
    throw new UpstreamError(
      400,
      `prompt 过长（${promptChars} 字符），当前模型 "${model}" 的上限是 ${limit} 字符` +
        `（上下文窗口 ${contextWindow ?? '未知'} token × ${CHARS_PER_TOKEN} 字符/token）。` +
        'Qoder 对超长输入不报错但会消耗大量积分，所以网关直接拒绝而不是截断。',
      { code: 'qoder_prompt_too_long' },
    );
  }

  // 签名失败保留 permanent 标记——登录过期是「只能重新登录」，网络抖动不是。
  let signed;
  try {
    const userInfo = await resolveSignatureUserInfo(account);
    const bodyJson = JSON.stringify(buildRequestBody(payload, model));
    signed = await signChatRequest(userInfo, bodyJson, model);
  } catch (error: any) {
    if (error instanceof UpstreamError) throw error;
    throw asCredentialError(error, 'Qoder 凭据不可用') ?? new UpstreamError(502, error.message, { code: 'qoder_sign_failed' });
  }

  const wantsStream = payload.stream !== false;
  const started = Date.now();
  const ignored = Object.keys(payload).filter((key) => IGNORED_PARAMS.includes(key));
  const unknown = Object.keys(payload).filter((key) => !IGNORED_PARAMS.includes(key) && !SUPPORTED_PARAMS.includes(key));

  log(
    `chat start account=${account.id} model=${model} messages=${messages.length} ` +
      `promptChars=${promptChars} limit=${limit} stream=${wantsStream}` +
      (ignored.length > 0 ? ` ignored=${ignored.join(',')}` : '') +
      (unknown.length > 0 ? ` unknown=${unknown.join(',')}` : ''),
  );
  if (unknown.length > 0) log(`客户端传了网关不认识的字段，已忽略：${unknown.join(',')}`);

  return wantsStream
    ? streamResponse(signed, model, account, request, started)
    : await collectedResponse(signed, model, account, request, started);
}

/**
 * 把客户端要的模型名解析成上游认的名字。上游对**不存在的模型静默退回 auto**，
 * 不在这里挡下来，用户选了已下线的模型会悄悄用别的模型回答，账单也对不上。
 */
async function resolveModel(requested: unknown): Promise<string> {
  const requestedName = typeof requested === 'string' ? requested : '';

  let known: string[] = [];
  try {
    known = await getModelNames();
  } catch (error: any) {
    // 拿不到名单不该让对话失败，但要留痕——这时模型名写错会静默变 auto。
    log(`取模型名单失败，跳过模型校验：${error.message}`);
  }

  if (requestedName === '') {
    return known.length > 0 ? known[0] : 'Auto';
  }
  if (known.length === 0) {
    // 名单拿不到时按原样传，不猜。
    return requestedName;
  }

  const resolved = resolveModelName(requestedName, known);
  if (!resolved) {
    throw new UpstreamError(400, `未知模型 "${requestedName}"。当前可用：${known.join(', ')}`, {
      code: 'qoder_unknown_model',
    });
  }
  return resolved;
}

/** 按 index 归并分片的 `tool_calls`。上游流式返回工具调用时**一个调用会被切成多帧**： `arguments` 是**字符串拼接**（不是 JSON 合并）。
 * 漏了归并，工具调用会**静默消失**—— 客户端拿到空 content，看起来像模型什么都没说。 */
function mergeToolCallDeltas(deltas: any[]): any[] {
  const byIndex = new Map<number, { id: string; type: string; name: string; arguments: string }>();

  for (const delta of deltas) {
    for (const call of delta) {
      const index = typeof call.index === 'number' ? call.index : 0;
      const entry = byIndex.get(index) ?? { id: '', type: 'function', name: '', arguments: '' };
      if (typeof call.id === 'string' && call.id !== '') entry.id = call.id;
      if (typeof call.type === 'string' && call.type !== '') entry.type = call.type;
      if (typeof call.function?.name === 'string') entry.name += call.function.name;
      if (typeof call.function?.arguments === 'string') entry.arguments += call.function.arguments;
      byIndex.set(index, entry);
    }
  }

  return [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, entry]) => ({
      index,
      id: entry.id,
      type: entry.type,
      function: { name: entry.name, arguments: entry.arguments },
    }));
}

/**
 * 非流式：把整条流读完拼起来一次性返回（上游只支持流式）。
 * 工具调用要单独归并（`mergeToolCallDeltas`），不归并就等于丢掉。
 */
async function collectedResponse(
  signed: HttpRequestSpec,
  model: string,
  account: Account,
  request: ChatRequest,
  started: number,
): Promise<ChatOutcome> {
  let text = '';
  let reasoning = '';
  let finishReason: string | null = null;
  let usage: ChatUsage | null = null;
  const toolCallDeltas: any[] = [];

  await new Promise<void>((resolve, reject) => {
    openSignedStream(
      signed,
      {
        onFrame: (frame) => {
          if (frame.kind === 'error') {
            reject(translateUpstreamError(frame.code, frame.message));
            return;
          }
          if (frame.kind !== 'chunk') return;

          usage = mergeUsage(usage, usageOf(frame.chunk));
          const choice = Array.isArray(frame.chunk.choices) ? frame.chunk.choices[0] : null;
          if (!choice) return;
          if (choice.delta?.content) text += choice.delta.content;
          if (choice.delta?.reasoning_content) reasoning += choice.delta.reasoning_content;
          if (Array.isArray(choice.delta?.tool_calls)) toolCallDeltas.push(choice.delta.tool_calls);
          if (choice.finish_reason) finishReason = choice.finish_reason;
        },
        onEnd: () => resolve(),
        onError: (e) => reject(e),
      },
      request.signal,
    );
  });

  const toolCalls = mergeToolCallDeltas(toolCallDeltas);

  request.onUsage?.(usage);
  maybeRefreshAfterChat();
  logUsage(account, model, usage, started);

  return {
    kind: 'json',
    status: 200,
    body: {
      id: completionId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            // 有工具调用时 content 可以是空串（OpenAI 允许），别强行填 null
            content: text,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
            // 工具调用必须带回去，否则客户端拿到的是一条「什么都没说」的空回复
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          // 有工具调用时 finish_reason 应当是 tool_calls；上游有时给 stop，
          // 按实际内容纠正，否则客户端的续跑逻辑不会触发
          finish_reason: toolCalls.length > 0 ? 'tool_calls' : (finishReason ?? 'stop'),
        },
      ],
      usage: usageToOpenAI(usage),
    },
  };
}

/**
 * 流式：上游帧一到就转一帧 SSE 推给客户端。内层 chunk 原样转发，只换 `id` / `created` / `model`——
 * 上游 id 是它自己的会话 id，混进账本会让人以为那是一次独立请求。
 */
function streamResponse(
  signed: HttpRequestSpec,
  model: string,
  account: Account,
  request: ChatRequest,
  started: number,
): ChatOutcome {
  const id = completionId();
  const created = Math.floor(Date.now() / 1000);

  const queue: string[] = [];
  let finished = false;
  const waiter: { wake: (() => void) | null } = { wake: null };

  const push = (text: string) => {
    queue.push(text);
    const wake = waiter.wake;
    waiter.wake = null;
    wake?.();
  };

  let usage: ChatUsage | null = null;

  const task = (async () => {
    try {
      await new Promise<void>((resolve, reject) => {
        openSignedStream(
          signed,
          {
            onFrame: (frame) => {
              if (frame.kind === 'error') {
                reject(translateUpstreamError(frame.code, frame.message));
                return;
              }
              if (frame.kind === 'timing') {
                log(`上游耗时：首字 ${frame.timing.firstTokenDuration}ms 总 ${frame.timing.totalDuration}ms`);
                return;
              }
              if (frame.kind !== 'chunk') return;

              usage = mergeUsage(usage, usageOf(frame.chunk));
              push(`data: ${JSON.stringify({ ...frame.chunk, id, created, model })}\n\n`);
            },
            onEnd: () => resolve(),
            onError: (e) => reject(e),
          },
          request.signal,
        );
      });

      push('data: [DONE]\n\n');
      request.onUsage?.(usage);
      maybeRefreshAfterChat();
      logUsage(account, model, usage, started);
    } catch (error: any) {
      // 客户端主动断开的不是错误，别刷日志、也别记 usage
      if (error?.code === 'qoder_client_aborted') {
        log(`chat ${model} 客户端断开，已中止上游`);
        return;
      }
      log(`chat ${model} 失败：${error.message}`);
      // 头早就发出去了，只能把错误作为流的一帧送出去——此时不能再改状态码。
      push(
        `data: ${JSON.stringify({ error: { message: error.message, type: 'gateway_error', code: error.code ?? 'qoder_upstream_error' } })}\n\n`,
      );
      push('data: [DONE]\n\n');
      request.onUsage?.(null);
    } finally {
      finished = true;
      const wake = waiter.wake;
      waiter.wake = null;
      wake?.();
    }
  })();
  void task;

  const stream = (async function* (): AsyncGenerator<string> {
    // 首帧立刻发出去，让客户端知道连接已建立——上游首字约 350ms，不发有些客户端会以为挂了。
    yield `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`;

    for (;;) {
      const next = queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (finished) return;
      await new Promise<void>((resolve) => {
        waiter.wake = resolve;
      });
    }
  })();

  return {
    kind: 'stream',
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
    body: stream,
  };
}

/** 一条统一的收尾日志，流式/非流式共用，避免两处格式漂移。 */
function logUsage(account: Account, model: string, usage: ChatUsage | null, started: number): void {
  const prompt = usage?.prompt_tokens ?? '?';
  const completion = usage?.completion_tokens ?? '?';
  log(
    `chat done account=${account.id} model=${model} status=200 ` +
      `credits=${usage?.credit ?? 0} tokens=${prompt}+${completion} ${Date.now() - started}ms`,
  );
}
