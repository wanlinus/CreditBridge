// WorkBuddy 对话传输层。
//
// 只有这个通道知道的对话细节都放这里：上游 host、客户端形状的 User-Agent、
// 线上会拒绝的请求体归一化、渠道过滤短语改写、以及 SSE 透传。
// 模型目录在 `models.ts`，额度与签到在 `usage.ts`，路由和账本在 `routes/` / `ledger.ts`。
//
// 和 Trae 不同，这里没有协议翻译：WorkBuddy 本来就用 OpenAI chunk 格式作答，
// 流是原样转发的，只顺带看一眼末尾那个 `usage` 帧。

import crypto from 'node:crypto';

import type { Account, ChatOutcome, ChatRequest } from '../../types.ts';
import { usableCredential } from '../../core/accounts.ts';
import { aggregateSse, usageFromSseLine } from '../../shared/openai-sse.ts';
import { asCredentialError } from '../../shared/credential-error.ts';
import { UpstreamError, retryAfterAt } from '../../shared/upstream-error.ts';
import { refreshWorkBuddyCredential, workBuddyIdeVersion, workBuddyUserAgent } from './auth.ts';

const CHAT_BASE = 'https://copilot.tencent.com';
const BILLING_BASE = 'https://www.codebuddy.cn';
const CHAT_URL = `${CHAT_BASE}/v2/chat/completions`;

/**
 * WorkBuddy 网关的渠道过滤会把这些说法当成"别家客户端"。
 * 移植自 dsh-workbuddy-connect 0.7.9-p1（MIT）。
 *
 * 过滤器认的是**短语**而不是整句：正文里出现 "DeepSeek Harness" 就回 400/11128，
 * 换成任何别的产品名都放行。所以改写范围故意收得很窄，只动这几处，工具 schema、
 * 系统指令和用户原话都不碰。
 */
const CHANNEL_PHRASE_REWRITES = [
  [/deepseek\s+harness/giu, 'the harness'],
  [/\bthe user explicitly referenced\b/giu, 'the user mentioned'],
  [/\brelative paths resolve from the workspace root\b/giu, 'relative paths resolve against the workspace root'],
];

let logSink: any = null;

export function setWorkBuddyUpstreamLogger(fn: any) {
  logSink = fn;
}

function log(...args: unknown[]) {
  if (logSink) logSink(`[workbuddy-upstream] ${args.join(' ')}`);
}

/** 32 位小写十六进制，客户端 `x-request-id` 就是这个形状。 */
function requestId() {
  return crypto.randomUUID().replace(/-/gu, '');
}

function uuid() {
  return crypto.randomUUID();
}

function sanitizeChannelText(text: any) {
  let out = text;
  for (const [pattern, replacement] of CHANNEL_PHRASE_REWRITES) out = out.replace(pattern, replacement);
  return out;
}

function sanitizeChannelPhrases(payload: any) {
  const messages = payload.messages;
  if (!Array.isArray(messages)) return;
  for (const message of messages) {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) continue;
    const content = message.content;
    if (typeof content === 'string') {
      if (content !== '') message.content = sanitizeChannelText(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part !== 'object' || part === null || Array.isArray(part)) continue;
      if (typeof part.text === 'string' && part.text !== '') part.text = sanitizeChannelText(part.text);
    }
  }
}

/** 把 `role: "developer"` 改写成 `system`：上游不认前者。 */
function normalizeDeveloperRole(payload: any) {
  if (!Array.isArray(payload.messages)) return;
  for (const message of payload.messages) {
    if (typeof message === 'object' && message !== null && message.role === 'developer') message.role = 'system';
  }
}

/**
 * 删掉 WorkBuddy 线上会拒绝或读错的请求字段。
 *
 * pi-ai 会带 `stream_options` 和几个 provider 私有上限，上游最好是忽略；
 * `tool_choice` 传对象形状必定 400，所以要摊平成字符串。
 */
function normalizeWireBody(payload: any) {
  delete payload.stream_options;
  delete payload.store;
  delete payload.metadata;
  delete payload.service_tier;
  delete payload.prediction;
  delete payload.parallel_tool_calls;
  delete payload.response_format;
  const choice = payload.tool_choice;
  if (choice !== undefined) {
    if (typeof choice === 'string') {
      if (choice.toLowerCase() === 'none') {
        delete payload.tool_choice;
        delete payload.tools;
        delete payload.functions;
      }
    } else if (typeof choice === 'object' && choice !== null) {
      const type = typeof choice.type === 'string' ? choice.type.toLowerCase() : '';
      if (type === 'none') {
        delete payload.tool_choice;
        delete payload.tools;
        delete payload.functions;
      } else if (type === 'auto' || type === 'required') {
        payload.tool_choice = type;
      } else if (type === 'function') {
        const name = (choice.function && typeof choice.function.name === 'string' && choice.function.name) || (typeof choice.name === 'string' && choice.name) || '';
        payload.tool_choice = name || 'auto';
      } else {
        delete payload.tool_choice;
      }
    } else {
      delete payload.tool_choice;
    }
  }
  if (payload.reasoning_effort === 'off' || payload.reasoning_effort === 'minimal') delete payload.reasoning_effort;
}

function chatHeaders(credential: any) {
  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: BILLING_BASE,
    Referer: `${BILLING_BASE}/`,
    'User-Agent': workBuddyUserAgent(),
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': workBuddyIdeVersion(),
    'X-Product': 'SaaS',
    'X-Request-Id': requestId(),
    'X-Conversation-ID': uuid(),
    'X-Conversation-Request-ID': uuid(),
    'X-Conversation-Message-ID': uuid(),
    Authorization: `Bearer ${credential.accessToken}`,
  };
  if (credential.uid) headers['X-User-Id'] = credential.uid;
  if (credential.enterpriseId) headers['X-Enterprise-Id'] = credential.enterpriseId;
  else headers['X-No-Enterprise-Id'] = '1';
  if (credential.domain) headers['X-Domain'] = credential.domain;
  return headers;
}

// ---------------------------------------------------------------- 对话

/**
 * 转发一次对话补全。
 *
 * 请求体会先归一化、再按渠道过滤短语改写；上游的 SSE 原样透传（它本来就是
 * OpenAI chunk 格式），只在流里顺带捞 `usage`。
 *
 * v2 的三处变化：凭据从 `account` 拿（不再自己读盘）、响应不写 `res`（返回
 * `ChatOutcome` 让路由层发）、失败抛 `UpstreamError`（让路由层改账号状态）。
 * 这样它变成一个**纯函数式的适配器**：给账号和请求，出结果，其余一概不管。
 */
export async function chatWorkBuddy(account: Account, request: ChatRequest): Promise<ChatOutcome> {
  const started = Date.now();
  const payload = request.body;
  const wantsStream = payload.stream !== false;
  payload.stream = true;
  // 在 normalizeWireBody() 丢掉 off/minimal 之前先记下来，否则日志分不清
  // 「客户端要求关闭」和「客户端根本没传」。
  const requestedEffort = typeof payload.reasoning_effort === 'string' ? payload.reasoning_effort : '(none)';
  normalizeDeveloperRole(payload);
  normalizeWireBody(payload);
  sanitizeChannelPhrases(payload);
  const sentEffort = typeof payload.reasoning_effort === 'string' ? payload.reasoning_effort : '(none)';

  const model = typeof payload.model === 'string' ? payload.model : '(none)';
  log(
    `chat start account=${account.id} model=${model} messages=${Array.isArray(payload.messages) ? payload.messages.length : 0} tools=${Array.isArray(payload.tools) ? payload.tools.length : 0} effort=${sentEffort}${sentEffort !== requestedEffort ? ` (requested ${requestedEffort}, stripped)` : ''}`,
  );

  // 客户端断开就掐掉上游；没给信号时按 10 分钟兜底，别让一次卡死的请求占着连接。
  const timeout = AbortSignal.timeout(600000);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

  // 401 时换一份凭据重发一次。
  //
  // 重试要用 `forceRefresh`：只重读账号文件的话，令牌没到期时读回来的还是同一枚
  // 被拒的令牌，等于白试一次。请求体已经解析成 `payload` 了，直接重发它——不能再
  // 从 req 读一遍，那是个已经读空的流。
  const body = JSON.stringify(payload);
  let upstream: Response | null = null;
  for (let attempt = 0; ; attempt += 1) {
    let credential;
    try {
      credential = await usableCredential(account, refreshWorkBuddyCredential, { forceRefresh: attempt > 0 });
    } catch (error: any) {
      // **原样透传 `permanent`**：凭据有过期/暂时不可用两种，路由层据此决定要不要把
      // 账号标成 invalid。直接 `new UpstreamError(502, msg)` 会把它压成普通 502，
      // 于是过期的号永远显示「就绪」——用户只看到「所有模型都报错」。
      log(`chat ${model} credential error: ${error.message}`);
      throw asCredentialError(error, 'WorkBuddy 凭据不可用') ?? new UpstreamError(502, error.message, { code: 'workbuddy_no_credential' });
    }
    try {
      upstream = await fetch(CHAT_URL, { method: 'POST', headers: chatHeaders(credential), body, signal });
    } catch (error: any) {
      log(`chat ${model} transport error: ${error.message}`);
      throw new UpstreamError(502, `WorkBuddy upstream transport error: ${error.message}`, { code: 'workbuddy_transport' });
    }
    if (upstream.status === 401 && attempt === 0) {
      log('chat got 401; refreshing credential and retrying once');
      await upstream.text().catch(() => '');
      continue;
    }
    break;
  }
  if (!upstream) throw new UpstreamError(502, 'WorkBuddy upstream 没有返回响应', { code: 'workbuddy_transport' });

  if (!upstream.ok) {
    const text = (await upstream.text()).slice(0, 4000);
    log(`chat ${model} upstream http ${upstream.status}: ${text.slice(0, 500)}`);
    let hint = '';
    if (upstream.status === 400 && /11128|请求被拦截|unapproved channel/u.test(text)) {
      hint = ' [渠道过滤：把触发拦截的说法加到 channels/workbuddy/upstream.ts 的 CHANNEL_PHRASE_REWRITES]';
    }
    throw new UpstreamError(upstream.status, `WorkBuddy upstream http ${upstream.status}: ${text}${hint}`, {
      code: `workbuddy_${upstream.status}`,
      retryAt: retryAfterAt(upstream.headers.get('retry-after')),
    });
  }

  const contentType = upstream.headers.get('content-type') || '';
  if (wantsStream && contentType.includes('text/event-stream')) {
    const upstreamBody = upstream.body!;
    const finished = `chat done account=${account.id} model=${model} status=${upstream.status} ${Date.now() - started}ms`;
    const stream = (async function* (): AsyncGenerator<string> {
      let pending = '';
      let usage = null;
      // 用流式 TextDecoder 解码：一个多字节字符可能跨两个 chunk，而 `toString('utf8')`
      // 会把劈开的两半变成替换字符——既污染转发出去的 SSE，也足以整帧丢掉 usage。
      const decoder = new TextDecoder('utf-8');
      try {
        for await (const chunk of upstreamBody) {
          const text = decoder.decode(chunk, { stream: true });
          pending += text;
          const lines = pending.split('\n');
          pending = lines.pop() || '';
          for (const line of lines) {
            const seen = usageFromSseLine(line);
            if (seen) usage = seen;
          }
          yield text;
        }
        const rest = decoder.decode();
        if (rest) {
          pending += rest;
          yield rest;
        }
        const tail = usageFromSseLine(pending);
        if (tail) usage = tail;
      } catch (error: any) {
        // 上游在流到一半时挂掉，或者客户端断开把上游 fetch 掐了（`request.signal`
        // 会传到 fetch，abort 时这里抛的是 `AbortError`，有时干脆是 `undefined`——
        // 不要写 `error.message`，那会在 error 为 undefined 时抛 TypeError，
        // 把整段日志变成 `stream error: undefined`，什么线索都没留下）。
        //
        // 响应头早就发出去了，只能记一笔然后断流；路由层拿到的仍是 200。
        const reason = error?.message || (request.signal?.aborted ? '客户端断开（aborted）' : String(error) || '上游断了');
        log(`chat ${model} stream error: ${reason}`);
      } finally {
        request.onUsage?.(usage);
        log(finished);
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

  // 非流式路径：把 SSE 分片聚合成一个完整 completion 对象。
  const text = await upstream.text();
  const aggregated = aggregateSse(text);
  request.onUsage?.(aggregated.usage ?? null);
  log(`chat done (aggregated) account=${account.id} model=${model} status=${upstream.status} ${Date.now() - started}ms`);
  return { kind: 'json', status: 200, body: aggregated };
}
