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

function normalizeWireBody(payload: any) {
  delete payload.stream_options;
  delete payload.store;
  delete payload.metadata;
  delete payload.service_tier;
  delete payload.prediction;
}

function normalizeUsage(usage: any) {
  if (!usage || typeof usage !== 'object') return usage;
  if (typeof usage.credit === 'number') return usage;
  const points = usage.points_consumed;
  return typeof points === 'number' ? { ...usage, credit: points } : usage;
}

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
    const finished = `chat done account=${account.id} model=${model} status=${upstream.status} ${Date.now() - started}ms`;
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
        request.onUsage?.(normalizeUsage(usage));
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

  const text = await upstream.text();
  const aggregated = aggregateSse(text);
  request.onUsage?.(normalizeUsage(aggregated.usage ?? null));
  log(`chat done (aggregated) account=${account.id} model=${model} status=${upstream.status} ${Date.now() - started}ms`);
  return { kind: 'json', status: 200, body: aggregated };
}
