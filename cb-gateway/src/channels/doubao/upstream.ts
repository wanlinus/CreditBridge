// 豆包对话传输层：OpenAI `messages` → 豆包 `content_block`，豆包 SSE `patch_op` → OpenAI chunk。
// 全项目协议差异最大的一家，四个反直觉的点：
//
// ① **`option.unique_key` 是唯一一个「少了就挂住」的字段**：缺它服务端一个字都不回，
//    客户端表现为 `UND_ERR_HEADERS_TIMEOUT`。其它几十个字段全可以删（已逐级二分验证）。
// ② **只认 `event: STREAM_CHUNK` + `patch_object === 1`**：`FULL_MSG_NOTIFY` 是「你发的消息」
//    的回显，`patch_object` 的 `111` 是客户端埋点，当成正文会得到乱码。
// ③ **正文是增量（delta）不是快照**，直接拼。但 `10040` 思考块只有状态文案、没有思维链正文。
// ④ **拿不到 token 用量**：SSE 里没有任何计数字段，所以这个通道 `reportsTokens: false`。

import crypto from 'node:crypto';

import type { Account, ChatOutcome, ChatRequest } from '../../types.ts';
import { usableCredential } from '../../core/accounts.ts';
import { asCredentialError } from '../../shared/credential-error.ts';
import { UpstreamError, retryAfterAt } from '../../shared/upstream-error.ts';
import { BOT_ID, refreshDoubaoCredential, webHeaders, webQuery, WEB_BASE } from './auth.ts';
import { extraParamsOf } from './models.ts';
import { riskControlError, riskControlOf } from './risk-control.ts';

const CHAT_PATH = '/chat/completion';
/** 对话上游实测 3~9 秒出全文；给足 5 分钟，长输出不掐。 */
const UPSTREAM_TIMEOUT_MS = 300_000;

let logSink: any = null;
export function setUpstreamLogger(fn: any) {
  logSink = fn;
}
function log(...args: unknown[]) {
  if (logSink) logSink(`[doubao-upstream] ${args.join(' ')}`);
}

/** OpenAI 的 `role` → 豆包的 `message_status` / 发送者语义。豆包只区分「用户」和「AI」。 */
function roleOf(message: any): 'user' | 'assistant' | 'system' {
  const role = String(message?.role || 'user');
  if (role === 'assistant') return 'assistant';
  if (role === 'system' || role === 'developer') return 'system';
  return 'user';
}

/** 取一条消息的纯文本。多模态内容只取文本片段——豆包这个接口不吃图。 */
function textOf(message: any): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
      .join('');
  }
  return '';
}

/**
 * 把 OpenAI 的 `messages` 折成豆包要的形状。
 *
 * **豆包是多轮串行语义**：一条用户消息配一条 AI 回复，交替出现。而 OpenAI 允许 system 打头、
 * 允许多轮 tool 结果。这里的处理是：system 合并进第一条用户消息的前面（豆包没有独立的
 * system 槽位），其余按原顺序铺开。
 */
function toContentBlocks(messages: any[]): { blocks: any[]; systemText: string } {
  const systemParts: string[] = [];
  const turns: { role: 'user' | 'assistant'; text: string }[] = [];

  for (const message of messages) {
    const role = roleOf(message);
    const text = textOf(message);
    if (!text) continue;
    if (role === 'system') {
      systemParts.push(text);
      continue;
    }
    turns.push({ role, text });
  }

  const blocks = turns.map((turn) => ({
    local_message_id: crypto.randomUUID(),
    content_block: [
      {
        block_type: 10000,
        content: {
          text_block: { text: turn.text, icon_url: '', icon_url_dark: '', summary: '' },
          pc_event_block: '',
        },
        block_id: crypto.randomUUID(),
        parent_id: '',
        meta_info: [],
        extra_info: {},
        append_fields: [],
      },
    ],
    message_status: 0,
  }));

  return { blocks, systemText: systemParts.join('\n\n') };
}

/**
 * 构造请求体。**只带实测必需 + 真正会影响回答的字段**，那些埋点/恢复/任务模式字段一律不带——
 * 字段越少，上游改版时越不容易坏。唯一的硬约束是 `option.unique_key` 不能省。
 */
function buildBody(messages: any[], modelKey: string, extraParams: Record<string, string>, reasoningEffort: string | null) {
  const { blocks, systemText } = toContentBlocks(messages);
  if (blocks.length === 0) {
    throw new UpstreamError(400, 'messages 里没有可发送的文本内容', { code: 'doubao_empty_messages' });
  }

  // system 没有独立槽位，拼到第一条用户消息前面。
  if (systemText) {
    const first = blocks[0];
    const textBlock = first?.content_block?.[0]?.content?.text_block;
    if (textBlock && typeof textBlock.text === 'string') {
      textBlock.text = `${systemText}\n\n${textBlock.text}`;
    }
  }

  const option: Record<string, unknown> = {
    unique_key: crypto.randomUUID(),
    model_config: {
      model_item_key: modelKey,
      // `memory_profile` 也要抄回去，只抄窗口大小上游会按自己的默认档跑。
      ...(Object.keys(extraParams).length > 0 ? { model_extra_params: extraParams } : {}),
      // 这个字段是**数字** level（3~7），不是字符串名。传字符串上游静默按默认档跑。
      ...(reasoningEffort ? { reasoning_effort: Number(reasoningEffort) || 5 } : {}),
    },
  };

  return {
    client_meta: {
      local_conversation_id: `local_${Date.now()}${Math.floor(Math.random() * 1e6)}`,
      conversation_id: '',
      bot_id: BOT_ID,
      last_section_id: '',
      last_message_index: null,
      local_permissions: [{ permission_name: 'ACCESS_COARSE_LOCATION', status: 0 }],
    },
    messages: blocks,
    option,
    user_context: [],
    ext: {},
  };
}

/** 网关档位名转回豆包的数字 level。`off` 没有对应档，返回 null（不传，上游用默认）。 */
const LEVEL_OF_EFFORT: Record<string, number> = {
  low: 3,
  medium: 4,
  high: 5,
  xhigh: 6,
  max: 7,
};

function levelOf(effort: unknown): string | null {
  const name = typeof effort === 'string' ? effort.trim().toLowerCase() : '';
  const level = LEVEL_OF_EFFORT[name];
  return level ? String(level) : null;
}

/** SSE 的一个事件块。 */
interface SseEvent {
  event: string;
  data: any;
}

/**
 * 从字节流里切 SSE 事件。
 *
 * **不能用 `shared/openai-sse.ts`**：那个按「一行一个 data」切，而豆包的帧是
 * `id:` + `event:` + `data:` 三行，且正文要按 `patch_object` 分派——格式完全不同。
 */
function makeSseSplitter() {
  let pending = '';
  return {
    push(text: string): SseEvent[] {
      pending += text;
      const events: SseEvent[] = [];
      for (;;) {
        // 事件之间空行分隔，兼容 \r\n。
        const match = /\r?\n\r?\n/.exec(pending);
        if (!match) break;
        const block = pending.slice(0, match.index);
        pending = pending.slice(match.index + match[0].length);
        const event = readEvent(block);
        if (event) events.push(event);
      }
      return events;
    },
    /** 收尾：最后可能没有空行结尾。 */
    flush(): SseEvent[] {
      if (!pending.trim()) return [];
      const block = pending;
      pending = '';
      const event = readEvent(block);
      return event ? [event] : [];
    },
  };
}

function readEvent(block: string): SseEvent | null {
  let event = '';
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!event && dataLines.length === 0) return null;
  const raw = dataLines.join('\n');
  if (!raw || raw === '[DONE]') return null;
  try {
    return { event, data: JSON.parse(raw) };
  } catch {
    // 半截帧/心跳，忽略。
    return null;
  }
}

/**
 * 从一帧里抽出正文增量、思考标题、以及上游错误。
 *
 * 只认 `STREAM_CHUNK` 且 `patch_object === 1`（`content_block`）。`50` 是 `ext`（窗口用量等），
 * 这里不读——那个数字不稳定，不参与记账。
 */
function readChunk(data: any): { text: string; thinking: string; error: UpstreamError | null } {
  const out = { text: '', thinking: '', error: null as UpstreamError | null };

  const patches = Array.isArray(data?.patch_op) ? data.patch_op : [];
  for (const patch of patches) {
    // `111` 是客户端埋点/渲染指令，`3` 是会话状态，都不是正文。
    if (Number(patch?.patch_object) !== 1) continue;
    const blocks = patch?.patch_value?.content_block;
    if (!Array.isArray(blocks)) continue;

    for (const block of blocks) {
      if (block?.block_type === 10000) {
        const text = block?.content?.text_block?.text;
        if (typeof text === 'string' && text !== '') out.text += text;
      } else if (block?.block_type === 10040) {
        // 只有状态标题（「正在调度资源」「已思考」），**没有思维链正文**。
        const thinking = block?.content?.thinking_block;
        const title = typeof thinking?.streaming_title === 'string' ? thinking.streaming_title : '';
        if (title && !out.thinking) out.thinking = title;
      }
    }
  }

  return out;
}

/** 上游错误码 → `UpstreamError`。**风控码必须映射成 429**（不改账号状态），映射成 401 会把号标成 invalid。 */
function upstreamErrorOf(data: any): UpstreamError | null {
  const code = Number(data?.error_code);
  if (!Number.isFinite(code) || code === 0) return null;
  const message = String(data?.error_msg || data?.message || `上游错误 ${code}`);

  // 风控统一走 `risk-control.ts` 的码表：710022004 的 error_msg 写的是 "rate limited"，
  // 但 decision 里是 shark_admin/verify，是风控不是限流。按 429 处理（账号状态不动），
  // 映射成 401 会把号误标成 invalid。
  const risk = riskControlOf(data);
  if (risk) return riskControlError(risk, '对话');

  // 登录态相关：cookie 过期/无效。
  if (code === 710010202 || code === 710012001 || code === 710010101) {
    return new UpstreamError(401, `豆包登录态失效：${message}（上游 ${code}），请重新导入 cookie`, {
      code: 'doubao_login_expired',
    });
  }
  return new UpstreamError(502, `豆包上游拒绝：${message}（上游 ${code}）`, { code: `doubao_${code}` });
}

function completionId(): string {
  return `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/** 转发一次对话补全。 */
export async function chatDoubao(account: Account, request: ChatRequest): Promise<ChatOutcome> {
  const payload = request.body;
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  if (messages.length === 0) {
    throw new UpstreamError(400, 'messages 不能为空', { code: 'doubao_empty_messages' });
  }

  const modelKey = typeof payload.model === 'string' ? payload.model : '';
  if (!modelKey) throw new UpstreamError(400, 'model 不能为空', { code: 'doubao_model_missing' });

  let credential;
  let extraParams: Record<string, string> = {};
  try {
    credential = await usableCredential(account, refreshDoubaoCredential);
    // 取不到模型表不该让对话失败：拿不到就按不带 extra_params 发，上游会用默认档。
    extraParams = await extraParamsOf(account, modelKey).catch((error: any) => {
      log(`取 model_extra_params 失败，按默认档发：${error.message}`);
      return {};
    });
  } catch (error: any) {
    throw asCredentialError(error, '豆包凭据不可用') ?? new UpstreamError(502, error.message, { code: 'doubao_no_credential' });
  }

  const wantsStream = payload.stream !== false;
  const effort = levelOf(payload.reasoning_effort);
  const body = buildBody(messages, modelKey, extraParams, effort);

  const started = Date.now();
  log(
    `chat start account=${account.id} model=${modelKey} messages=${messages.length} ` +
      `blocks=${body.messages.length} effort=${effort ?? '(默认)'} stream=${wantsStream}`,
  );

  const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  const url = `${WEB_BASE}${CHAT_PATH}?${webQuery(credential)}`;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: webHeaders(credential, { Accept: 'text/event-stream' }),
      body: JSON.stringify(body),
      signal,
    });
  } catch (error: any) {
    log(`chat ${modelKey} transport error: ${error.message}`);
    throw new UpstreamError(502, `豆包上游连接失败：${error.message}`, { code: 'doubao_transport' });
  }

  if (!upstream.ok) {
    const text = (await upstream.text().catch(() => '')).slice(0, 2000);
    log(`chat ${modelKey} upstream http ${upstream.status}: ${text.slice(0, 400)}`);
    throw new UpstreamError(upstream.status, `豆包上游 HTTP ${upstream.status}：${text}`, {
      code: `doubao_http_${upstream.status}`,
      retryAt: retryAfterAt(upstream.headers.get('retry-after')),
    });
  }

  const stream = wantsStream
    ? streamResponse(upstream, modelKey, account, request, started)
    : collectedResponse(upstream, modelKey, account, request, started);
  return stream;
}

/**
 * 流式：把豆包的帧翻成 OpenAI chunk 推给客户端。
 *
 * 首帧先发一个 `role: assistant`，让客户端知道连接建立（上游首包实测 700ms 左右，
 * 不发有些客户端会以为挂了）。
 */
function streamResponse(
  upstream: Response,
  modelKey: string,
  account: Account,
  request: ChatRequest,
  started: number,
): ChatOutcome {
  const id = completionId();
  const created = Math.floor(Date.now() / 1000);

  const generator = (async function* (): AsyncGenerator<string> {
    const splitter = makeSseSplitter();
    const decoder = new TextDecoder('utf-8');
    let thinkingSent = '';
    let chars = 0;
    let finished = false;

    yield chunkFrame(id, created, modelKey, { role: 'assistant' }, null);

    const emit = (data: any) => {
      const pieces: string[] = [];
      for (const event of splitter.push(data)) {
        if (event.event === 'STREAM_ERROR') {
          const error = upstreamErrorOf(event.data) ?? new UpstreamError(502, '豆包上游返回未知错误');
          throw error;
        }
        // **只处理 STREAM_CHUNK**：FULL_MSG_NOTIFY 是「你发的消息」的回显。
        if (event.event !== 'STREAM_CHUNK') continue;
        const parsed = readChunk(event.data);
        if (parsed.thinking && parsed.thinking !== thinkingSent) {
          thinkingSent = parsed.thinking;
          pieces.push(chunkFrame(id, created, modelKey, { reasoning_content: `${parsed.thinking}\n` }, null));
        }
        if (parsed.text) {
          chars += parsed.text.length;
          pieces.push(chunkFrame(id, created, modelKey, { content: parsed.text }, null));
        }
      }
      return pieces;
    };

    try {
      const reader = upstream.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        for (const frame of emit(text)) yield frame;
      }
      const rest = decoder.decode();
      if (rest) for (const frame of emit(rest)) yield frame;
      for (const event of splitter.flush()) {
        if (event.event === 'STREAM_ERROR') {
          throw upstreamErrorOf(event.data) ?? new UpstreamError(502, '豆包上游返回未知错误');
        }
      }
      finished = true;
      yield chunkFrame(id, created, modelKey, {}, 'stop');
      yield 'data: [DONE]\n\n';
      log(`chat done account=${account.id} model=${modelKey} status=200 chars=${chars} ${Date.now() - started}ms`);
    } catch (error: any) {
      // 客户端主动断开不是错误：别刷日志、别往流里推错误帧。
      if (request.signal?.aborted) {
        log(`chat ${modelKey} 客户端断开`);
        return;
      }
      // **头早就发出去了，不能再改状态码**。抛出去只会让路由 `controller.error()`
      // 直接掐断连接，客户端看到的是 `UND_ERR_SOCKET other side closed`——
      // 一个什么信息都没有的失败。要像 Qoder 那样把错误当成流里的一帧送出去。
      const failure =
        error?.name === 'TimeoutError'
          ? new UpstreamError(504, `豆包上游超时（${UPSTREAM_TIMEOUT_MS / 1000} 秒没有响应）`, { code: 'doubao_timeout' })
          : error;
      const message = failure?.message || String(failure);
      log(`chat ${modelKey} 流中失败：${message}`);
      yield `data: ${JSON.stringify({
        error: {
          message,
          type: 'gateway_error',
          code: typeof failure?.code === 'string' ? failure.code : 'doubao_stream_error',
        },
      })}\n\n`;
      yield 'data: [DONE]\n\n';
    } finally {
      if (!finished) log(`chat ${modelKey} 流提前结束，已输出 ${chars} 字符`);
      // 拿不到 token，只能记 null——账本里 null 是「上游没报」，不是 0。
      request.onUsage?.(null);
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
    body: generator,
  };
}

/** 一个 OpenAI `chat.completion.chunk` 帧。 */
function chunkFrame(id: string, created: number, model: string, delta: any, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

/** 非流式：读完整个流拼成 `chat.completion`。 */
async function collectedResponse(
  upstream: Response,
  modelKey: string,
  account: Account,
  request: ChatRequest,
  started: number,
): Promise<ChatOutcome> {
  const splitter = makeSseSplitter();
  const decoder = new TextDecoder('utf-8');
  let content = '';
  let thinking = '';
  let upstreamFailure: UpstreamError | null = null;

  const consume = (chunks: SseEvent[]) => {
    for (const event of chunks) {
      if (event.event === 'STREAM_ERROR') {
        upstreamFailure = upstreamErrorOf(event.data) ?? new UpstreamError(502, '豆包上游返回未知错误');
        return;
      }
      if (event.event !== 'STREAM_CHUNK') continue;
      const parsed = readChunk(event.data);
      content += parsed.text;
      if (parsed.thinking && !thinking) thinking = parsed.thinking;
    }
  };

  try {
    const reader = upstream.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      consume(splitter.push(decoder.decode(value, { stream: true })));
      if (upstreamFailure) break;
    }
    if (!upstreamFailure) {
      const rest = decoder.decode();
      if (rest) consume(splitter.push(rest));
      consume(splitter.flush());
    }
  } catch (error: any) {
    request.onUsage?.(null);
    if (request.signal?.aborted) throw new UpstreamError(499, '客户端已断开', { code: 'doubao_client_aborted' });
    throw new UpstreamError(502, `豆包上游流读取失败：${error.message}`, { code: 'doubao_stream_error' });
  }

  request.onUsage?.(null);

  if (upstreamFailure) throw upstreamFailure;
  if (content === '') {
    throw new UpstreamError(502, '豆包上游没有返回任何正文（可能被风控或模型拒绝）', { code: 'doubao_empty_reply' });
  }

  log(`chat done account=${account.id} model=${modelKey} status=200 chars=${content.length} ${Date.now() - started}ms`);

  return {
    kind: 'json',
    status: 200,
    body: {
      id: completionId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelKey,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content,
            ...(thinking ? { reasoning_content: thinking } : {}),
          },
          finish_reason: 'stop',
        },
      ],
      // 上游不报 token，显式给 null 而不是 0——0 会被读成「确实没消耗」。
      usage: null,
    },
  };
}
