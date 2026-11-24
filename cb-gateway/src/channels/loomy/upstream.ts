// Loomy 对话传输层：标准 OpenAI 兼容 `/chat/completions` 的透传。
//
// 和 WorkBuddy 一样，上游本来就是 OpenAI chunk 格式，所以流是原样转发，只顺带捞
// 末尾的 `usage` 帧。区别在两点：
//   1. 认证是 `token` 头 + `Authorization: Bearer`（session 当令牌），见 `auth.ts`。
//   2. 必须带 `traceparent` 追踪头——实测 Loomy iModel 缺它时 `/chat/completions`
//      会挂死直到超时。
//
// session 无刷新机制：401 时只能抛 `UpstreamError(401)` 让路由层把账号标成 invalid，
// 用户在管理台重新登录。这里不做「换令牌重试」——没有令牌可换。

import type { Account, ChatOutcome, ChatRequest } from '../../types.ts';
import { usableCredential } from '../../core/accounts.ts';
import { aggregateSse, usageFromSseLine } from '../../shared/openai-sse.ts';
import { asCredentialError } from '../../shared/credential-error.ts';
import { UpstreamError, retryAfterAt } from '../../shared/upstream-error.ts';
import { generateTraceparent, loomyApiHeaders, refreshLoomyCredential } from './auth.ts';

const CHAT_URL = 'https://loomyad.xunfei.cn/api/v1/chat/completions';
const UPSTREAM_TIMEOUT_MS = 600000;

let logSink: any = null;
export function setLoomyUpstreamLogger(fn: any) {
  logSink = fn;
}
function log(...args: unknown[]) {
  if (logSink) logSink(`[loomy-upstream] ${args.join(' ')}`);
}

/**
 * 归一化请求体：丢掉上游会拒绝或读错的字段。
 *
 * 客户端 `llm-completion.js` 发的 body 就带 `enable_thinking` / `chat_template_kwargs`
 * 两个非标准字段（对非 reasoning 模型是 noop）。DSH 发来的请求不会有这些，但可能带
 * `stream_options` 等 provider 私有字段，上游最差是忽略、最好也是拒，统一删掉。
 */
function normalizeWireBody(payload: any) {
  delete payload.stream_options;
  delete payload.store;
  delete payload.metadata;
  delete payload.service_tier;
  delete payload.prediction;
}

/**
 * 把 Loomy 的 `usage` 归一成账本认识的口径。
 *
 * 上游报的单次积分叫 **`points_consumed`**，而账本统一读 `credit`（见 `ledger.ts`）。
 * 不做这个映射，Loomy 的积分消耗在账本里全是 `null`：概览的消耗不含它、按通道的图里
 * 它恒为 0——**字段名对不上不报错，只让统计静默偏小**。
 *
 * 归一化放在通道里而不是 `ledger.ts`：`points_consumed` 是 Loomy 专有的叫法，账本
 * 不该知道每个通道的私有字段名（和 `idPrefix`、客户端版本串同一条理由——通道自述）。
 */
function normalizeUsage(usage: any) {
  if (!usage || typeof usage !== 'object') return usage;
  if (typeof usage.credit === 'number') return usage;
  const points = usage.points_consumed;
  return typeof points === 'number' ? { ...usage, credit: points } : usage;
}

/**
 * 一行日志里说清「这次请求贵不贵」。
 *
 * Loomy 是**前缀缓存**：首次出现的内容必然全价。所以「一次塞进几十万 token 全新内容」
 * 和「在已有对话上追加一句」成本差几十倍，而这两件事在只有 `chat done ... 142084ms`
 * 的日志里长得一模一样——事后翻账本才知道缓存命中只有 1.3%。
 *
 * 命中率低于一半时额外提示一句：正常多轮对话在 95% 上下，掉下来是异常信号。
 */
function finishedLine(usage: any, accountId: string, model: string, status: number, started: number) {
  const base = `chat done account=${accountId} model=${model} status=${status} ${Date.now() - started}ms`;
  const prompt = usage?.prompt_tokens;
  if (typeof prompt !== 'number' || prompt <= 0) return base;

  const cached = usage?.prompt_tokens_details?.cached_tokens;
  const credit = usage?.credit;
  const creditText = typeof credit === 'number' ? ` credit=${credit}` : '';
  if (typeof cached !== 'number') {
    // 上游没报缓存字段：只报量，不猜命中率（「不知道」和「0」不是一回事）。
    return `${base} prompt=${prompt}${creditText}`;
  }

  const uncached = prompt - cached;
  const ratio = cached / prompt;
  const rate = (ratio * 100).toFixed(1);
  const line = `${base} prompt=${prompt} cached=${cached} uncached=${uncached} hit=${rate}%${creditText}`;
  // 低于 50% 才提示：正常多轮对话在 95% 上下，掉下来通常意味着「整段新内容一次性进来」。
  return ratio < 0.5 ? `${line} ⚠️ 缓存命中偏低（大段新内容按全价计费）` : line;
}

/** 转发一次对话补全。 */
export async function chatLoomy(account: Account, request: ChatRequest): Promise<ChatOutcome> {
  const started = Date.now();
  const payload = request.body;
  const wantsStream = payload.stream !== false;
  payload.stream = true;

  normalizeWireBody(payload);
  const model = typeof payload.model === 'string' ? payload.model : '(none)';
  log(`chat start account=${account.id} model=${model} messages=${Array.isArray(payload.messages) ? payload.messages.length : 0}`);

  const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

  let credential;
  try {
    credential = await usableCredential(account, refreshLoomyCredential);
  } catch (error: any) {
    // session 不存在或（更常见的）已过期。Loomy 没有 refresh token，所以这里一定是
    // `permanent`——原样透传让路由把账号标 invalid。别用固定 401 表达这个语义：
    // 网络类错误一旦混进来就会误封账号。
    throw asCredentialError(error, 'Loomy 凭据不可用') ?? new UpstreamError(401, error.message, { code: 'loomy_no_credential' });
  }

  const body = JSON.stringify(payload);
  let upstream: Response;
  try {
    upstream = await fetch(CHAT_URL, {
      method: 'POST',
      headers: loomyApiHeaders(credential.session, { traceparent: generateTraceparent() }),
      body,
      signal,
    });
  } catch (error: any) {
    log(`chat ${model} transport error: ${error.message}`);
    throw new UpstreamError(502, `Loomy upstream transport error: ${error.message}`, { code: 'loomy_transport' });
  }

  if (!upstream.ok) {
    const text = (await upstream.text().catch(() => '')).slice(0, 2000);
    log(`chat ${model} upstream http ${upstream.status}: ${text.slice(0, 400)}`);
    throw new UpstreamError(upstream.status, `Loomy upstream http ${upstream.status}: ${text}`, {
      code: `loomy_${upstream.status}`,
      retryAt: retryAfterAt(upstream.headers.get('retry-after')),
    });
  }

  const contentType = upstream.headers.get('content-type') || '';
  if (wantsStream && contentType.includes('text/event-stream')) {
    const upstreamBody = upstream.body!;
    const stream = (async function* (): AsyncGenerator<string> {
      let pending = '';
      let usage = null;
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
        const reason = error?.message || (request.signal?.aborted ? '客户端断开（aborted）' : String(error) || '上游断了');
        log(`chat ${model} stream error: ${reason}`);
      } finally {
        // 账本读的是 `credit`，上游报的是 `points_consumed`，这里换算（见 `normalizeUsage`）。
        const normalized = normalizeUsage(usage);
        request.onUsage?.(normalized);
        log(`${finishedLine(normalized, account.id, model, upstream.status, started)}`);
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

  // 非流式：把 SSE 分片聚合成完整 completion 对象。
  const text = await upstream.text();
  const aggregated = aggregateSse(text);
  // 返回给客户端的 body 保持上游原样（透传），只有交给账本的那份做换算。
  const normalized = normalizeUsage(aggregated.usage ?? null);
  request.onUsage?.(normalized);
  log(`${finishedLine(normalized, account.id, model, upstream.status, started)} (aggregated)`);
  return { kind: 'json', status: 200, body: aggregated };
}
