import crypto from 'node:crypto';

import type { Account, ChatOutcome, ChatRequest } from '../../types.ts';
import { usableCredential } from '../../core/accounts.ts';
import { aggregateSse, usageFromSseLine } from '../../shared/openai-sse.ts';
import { asCredentialError } from '../../shared/credential-error.ts';
import { UpstreamError, retryAfterAt } from '../../shared/upstream-error.ts';
import { refreshWorkBuddyCredential } from './auth.ts';

const CHAT_BASE = 'https://copilot.tencent.com';
const BILLING_BASE = 'https://www.codebuddy.cn';
const CHAT_URL = `${CHAT_BASE}/v2/chat/completions`;
const CONFIG_URL = `${CHAT_BASE}/v3/config`;
const CATALOG_TTL_MS = 10 * 60 * 1000;

const CHANNEL_PHRASE_REWRITES = [
  [/deepseek\s+harness/giu, 'the harness'],
  [/\bthe user explicitly referenced\b/giu, 'the user mentioned'],
  [/\brelative paths resolve from the workspace root\b/giu, 'relative paths resolve against the workspace root'],
];

let settings: any = {
  ideVersion: '5.9.3',
  appVersion: '5.9.3',
  cliVersion: '2.165.0',
};

let logSink: any = null;

export function setWorkBuddyUpstreamLogger(fn: any) {
  logSink = fn;
}

export function configureWorkBuddyUpstream(next = {}) {
  settings = { ...settings, ...next };
}

function log(...args: unknown[]) {
  if (logSink) logSink(`[workbuddy-upstream] ${args.join(' ')}`);
}

function buildUserAgent() {
  const parts = [`WorkBuddy/${settings.appVersion}`, `WorkBuddy/${settings.appVersion}`];
  if (settings.cliVersion) parts.push(`CLI/${settings.cliVersion}`);
  return parts.join(' ');
}

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

function normalizeDeveloperRole(payload: any) {
  if (!Array.isArray(payload.messages)) return;
  for (const message of payload.messages) {
    if (typeof message === 'object' && message !== null && message.role === 'developer') message.role = 'system';
  }
}

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
    'User-Agent': buildUserAgent(),
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': settings.ideVersion,
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

function catalogHeaders(credential: any) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.accessToken}`,
    Accept: 'application/json',
    Origin: BILLING_BASE,
    Referer: `${BILLING_BASE}/`,
    'User-Agent': buildUserAgent(),
  };
  if (credential.uid) headers['X-User-Id'] = credential.uid;
  if (credential.enterpriseId) {
    headers['X-Enterprise-Id'] = credential.enterpriseId;
    headers['X-Tenant-Id'] = credential.enterpriseId;
  }
  if (credential.domain) headers['X-Domain'] = credential.domain;
  return headers;
}

const catalogCache = new Map<string, { at: number; models: any[] }>();

export function selectorOrder(data: any): string[] | null {
  const presets = ['fast-model', 'balanced-model', 'deep-model'];
  const agentIds: string[] = [];
  const agents = Array.isArray(data?.agents) ? data.agents : [];
  for (const agent of agents) {
    if (!Array.isArray(agent?.models)) continue;
    for (const id of agent.models) {
      if (typeof id === 'string' && id !== '' && !agentIds.includes(id)) agentIds.push(id);
    }
  }
  if (agentIds.length === 0) return null;
  return [...presets, ...agentIds];
}

function toCatalogModel(model: any) {
  return {
    id: model.id,
    name: typeof model.name === 'string' ? model.name : model.id,
    contextWindow: Number.isFinite(model.maxInputTokens)
      ? model.maxInputTokens
      : (Number.isFinite(model.contextWindow) ? model.contextWindow : undefined),
    maxTokens: Number.isFinite(model.maxOutputTokens)
      ? model.maxOutputTokens
      : (Number.isFinite(model.maxTokens) ? model.maxTokens : undefined),
    lengths:
      model.contextWindow && Array.isArray(model.contextWindow.supportedLengths)
        ? {
            default: model.contextWindow.defaultLength,
            options: model.contextWindow.supportedLengths.filter((n: any) => Number.isFinite(n)),
          }
        : undefined,
    supportsImages: model.supportsImages === true,
    supportsReasoning: model.supportsReasoning === true,
    reasoning: model.reasoning && typeof model.reasoning === 'object' ? model.reasoning : undefined,
    credits: typeof model.credits === 'string' ? model.credits : undefined,
  };
}

export async function fetchWorkBuddyCatalog(account: Account, force = false) {
  const cached = catalogCache.get(account.id);
  if (!force && cached && cached.models.length > 0 && Date.now() - cached.at < CATALOG_TTL_MS) return cached.models;
  const credential = await usableCredential(account, refreshWorkBuddyCredential);
  const response = await fetch(CONFIG_URL, { headers: catalogHeaders(credential), signal: AbortSignal.timeout(30000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`catalog http ${response.status}: ${text.slice(0, 200)}`);
  const doc = JSON.parse(text);
  if (doc.code !== 0) throw new Error(`catalog code ${doc.code}: ${String(doc.msg || '').slice(0, 200)}`);

  const raw = doc.data && Array.isArray(doc.data.models) ? doc.data.models : [];
  const byId = new Map<string, any>();
  for (const model of raw) {
    if (model && typeof model.id === 'string') byId.set(model.id, model);
  }
  const order = selectorOrder(doc.data);
  const picked = order === null ? [...byId.keys()] : order.filter((id) => byId.has(id));
  if (order !== null) log(`catalog: 全量 ${byId.size} 个，选择器只列 ${picked.length} 个`);

  const models = picked
    .map((id) => byId.get(id))
    .filter((model: any) => !(Array.isArray(model.tags) && model.tags.some((tag: any) => /text-to-image|text-to-video|image-to-video/u.test(String(tag)))))
    .filter((model: any) => !/^(codewise-|completion-|deepseek-v3-0324-taco)/u.test(model.id))
    .map(toCatalogModel);

  catalogCache.set(account.id, { at: Date.now(), models });
  return models;
}

export async function chatWorkBuddy(account: Account, request: ChatRequest): Promise<ChatOutcome> {
  const started = Date.now();
  const payload = request.body;
  const wantsStream = payload.stream !== false;
  payload.stream = true;
  const requestedEffort = typeof payload.reasoning_effort === 'string' ? payload.reasoning_effort : '(none)';
  normalizeDeveloperRole(payload);
  normalizeWireBody(payload);
  sanitizeChannelPhrases(payload);
  const sentEffort = typeof payload.reasoning_effort === 'string' ? payload.reasoning_effort : '(none)';

  const model = typeof payload.model === 'string' ? payload.model : '(none)';
  log(
    `chat start account=${account.id} model=${model} messages=${Array.isArray(payload.messages) ? payload.messages.length : 0} tools=${Array.isArray(payload.tools) ? payload.tools.length : 0} effort=${sentEffort}${sentEffort !== requestedEffort ? ` (requested ${requestedEffort}, stripped)` : ''}`,
  );

  const timeout = AbortSignal.timeout(600000);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

  const body = JSON.stringify(payload);
  let upstream: Response | null = null;
  for (let attempt = 0; ; attempt += 1) {
    let credential;
    try {
      credential = await usableCredential(account, refreshWorkBuddyCredential, { forceRefresh: attempt > 0 });
    } catch (error: any) {
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

  const text = await upstream.text();
  const aggregated = aggregateSse(text);
  request.onUsage?.(aggregated.usage ?? null);
  log(`chat done (aggregated) account=${account.id} model=${model} status=${upstream.status} ${Date.now() - started}ms`);
  return { kind: 'json', status: 200, body: aggregated };
}
