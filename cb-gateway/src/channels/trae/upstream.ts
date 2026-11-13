import crypto from 'node:crypto';

import type { Account, ChatOutcome, ChatRequest } from '../../types.ts';
import { usableCredential } from '../../core/accounts.ts';
import { UpstreamError, retryAfterAt } from '../../shared/upstream-error.ts';
import { asCredentialError } from '../../shared/credential-error.ts';
import { TRAE_CHAT_BASE, refreshTraeCredential, traeHeaders } from './auth.ts';
import { effectiveLimits, fetchTraeModelConfig, traeVariantModelName } from './config.ts';

let logSink: (...args: any[]) => void = () => {};
export function setTraeUpstreamLogger(fn: (...args: any[]) => void) {
  logSink = fn;
}

const CHAT_PATH = '/api/agent/v3/llm_utils_chat';
const UPSTREAM_TIMEOUT_MS = 600000;

function mapReasoningLevel(effort: any) {
  if (effort === undefined || effort === null || effort === '') return 'high';
  const value = String(effort).toLowerCase();
  if (value === 'off' || value === 'none' || value === 'minimal' || value === 'low' || value === 'light') return 'light';
  if (value === 'xhigh' || value === 'max' || value === 'extra_high') return 'extra_high';
  return 'high';
}

function modelSelector(model: string, variant: string | null) {
  return variant ? { config_name: model, model_name: variant } : {};
}

function traeModelName(requested: unknown) {
  return typeof requested === 'string' ? requested : '';
}

function imageUrlOf(part: any) {
  const inner = part.image_url;
  if (typeof inner === 'string' && inner !== '') return inner;
  if (inner && typeof inner === 'object' && typeof inner.url === 'string' && inner.url !== '') return inner.url;
  if (typeof part.url === 'string' && part.url !== '') return part.url;
  if (part.source && typeof part.source === 'object' && part.source.type === 'base64' && typeof part.source.data === 'string') {
    const media = typeof part.source.media_type === 'string' ? part.source.media_type : 'image/png';
    return `data:${media};base64,${part.source.data}`;
  }
  return '';
}

function toParts(content: any) {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const part of content) {
    if (typeof part === 'string') {
      if (part !== '') parts.push({ type: 'text', text: part });
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    const type = typeof part.type === 'string' ? part.type : '';
    if (type === 'text' && typeof part.text === 'string') {
      if (part.text !== '') parts.push({ type: 'text', text: part.text });
    } else if (type === 'input_text' && typeof part.text === 'string') {
      if (part.text !== '') parts.push({ type: 'text', text: part.text });
    } else if (type === 'image_url' || type === 'image' || type === 'input_image') {
      const url = imageUrlOf(part);
      if (url !== '') parts.push({ type: 'image_url', image_url: { url } });
    }
  }
  return parts;
}

function toTraeToolCalls(toolCalls: any) {
  if (!Array.isArray(toolCalls)) return undefined;
  const out = [];
  for (const call of toolCalls) {
    if (!call || typeof call !== 'object') continue;
    const fn = call.function_call || call.function || {};
    const name = typeof fn.name === 'string' ? fn.name : '';
    let args = fn.arguments;
    if (typeof args !== 'string') {
      try {
        args = JSON.stringify(args ?? {});
      } catch {
        args = '{}';
      }
    }
    if (name === '') continue;
    out.push({
      index: out.length,
      id: typeof call.id === 'string' && call.id !== '' ? call.id : crypto.randomUUID(),
      type: 'function',
      function_call: { name, arguments: args },
    });
  }
  return out.length > 0 ? out : undefined;
}

function toTraeTools(tools: any) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out = [];
  for (const tool of tools) {
    const fn = tool && (tool.function || tool);
    if (!fn || typeof fn.name !== 'string' || fn.name === '') continue;
    let parameters = fn.parameters;
    if (parameters === undefined || parameters === null) parameters = { type: 'object', properties: {} };
    let serialized;
    try {
      serialized = typeof parameters === 'string' ? parameters : JSON.stringify(parameters);
    } catch {
      serialized = '{"type":"object","properties":{}}';
    }
    out.push({
      type: 'function',
      function: {
        name: fn.name,
        description: typeof fn.description === 'string' ? fn.description : '',
        parameters: serialized,
      },
    });
  }
  return out.length > 0 ? out : undefined;
}

function buildTraeBody(payload: any, sessionId: any, variant: string | null) {
  const rawMessages = Array.isArray(payload.messages) ? payload.messages : [];
  const messages = [];
  for (const message of rawMessages) {
    if (!message || typeof message !== 'object') continue;
    const role = typeof message.role === 'string' ? message.role : 'user';

    if (role === 'tool' || role === 'function') {
      const parts = toParts(message.content);
      messages.push({
        role: 'tool',
        tool_call_id: typeof message.tool_call_id === 'string' ? message.tool_call_id : '',
        content: parts.length > 0 ? parts : [{ type: 'text', text: '' }],
      });
      continue;
    }

    const normalizedRole = role === 'developer' ? 'system' : role;
    if (normalizedRole !== 'system' && normalizedRole !== 'user' && normalizedRole !== 'assistant') continue;

    const entry: any = { role: normalizedRole, content: toParts(message.content) };
    if (!entry.content.length) entry.content = [{ type: 'text', text: '' }];

    if (normalizedRole === 'assistant') {
      const toolCalls = toTraeToolCalls(message.tool_calls);
      if (toolCalls) entry.tool_calls = toolCalls;
    }
    messages.push(entry);
  }

  const model = traeModelName(payload.model);
  const level = mapReasoningLevel(payload.reasoning_effort);
  const carriesImage = messages.some(
    (m: any) => Array.isArray(m.content) && m.content.some((p: any) => p && p.type === 'image_url'),
  );
  const body: any = {
    messages,
    model,
    ...modelSelector(model, variant),
    function: 'chat_v3',
    stream: true,
    request_id: sessionId,
    session_id: sessionId,
    reasoning_effort_level: level,
    custom_model: {
      provider: '',
      config_name: model,
      display_model_name: model,
      model_name: variant || model,
      is_preset: true,
      config_source: 1,
      multimodal: carriesImage,
      reasoning_effort_level: level,
    },
  };

  const tools = toTraeTools(payload.tools);
  if (tools) body.tools = tools;
  if (typeof payload.max_tokens === 'number' && payload.max_tokens > 0) body.max_tokens = payload.max_tokens;
  if (typeof payload.temperature === 'number') body.temperature = payload.temperature;
  return body;
}

function frameSplitter() {
  let buffer = '';
  return {
    push(text: any) {
      buffer += text;
      const frames = [];
      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        frames.push(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf('\n\n');
      }
      return frames;
    },
    flush() {
      const rest = buffer;
      buffer = '';
      return rest.trim() === '' ? [] : [rest];
    },
  };
}

function parseFrame(frame: any) {
  let event = '';
  const dataLines = [];
  for (const line of frame.split(/\r?\n/u)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  const raw = dataLines.join('');
  if (raw === '') return { event, data: undefined };
  try {
    return { event, data: JSON.parse(raw) };
  } catch {
    return { event, data: raw };
  }
}

function openAiChunk(id: any, model: any, delta: any, finishReason?: any, usage?: any) {
  const chunk: any = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: finishReason === undefined
      ? [{ index: 0, delta, finish_reason: null }]
      : [{ index: 0, delta: {}, finish_reason: finishReason }],
  };
  if (usage) chunk.usage = usage;
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function openAiErrorChunk(_id: any, _model: any, message: any) {
  return `data: ${JSON.stringify({ error: { message, type: 'trae_upstream_error', code: 'trae_error' } })}\n\n`;
}

export function mapTraeTokenUsage(data: any): any | null {
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.prompt_tokens !== 'number') {
    return null;
  }
  const counter = (value: any): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  const cacheRead = counter(data.cache_read_input_tokens);
  const cacheWrite = counter(data.cache_creation_input_tokens);
  const details: any = {};
  if (cacheRead !== undefined) details.cached_tokens = cacheRead;
  if (cacheWrite !== undefined) details.cache_write_tokens = cacheWrite;

  return {
    prompt_tokens: data.prompt_tokens,
    completion_tokens: data.completion_tokens,
    total_tokens: data.total_tokens,
    ...(typeof data.reasoning_tokens === 'number' ? { completion_tokens_details: { reasoning_tokens: data.reasoning_tokens } } : {}),
    ...(Object.keys(details).length > 0 ? { prompt_tokens_details: details } : {}),
  };
}

export async function chatTrae(account: Account, request: ChatRequest): Promise<ChatOutcome> {
  const started = Date.now();
  const payload = request.body;
  const requestedModel = traeModelName(payload.model);
  const sessionId = crypto.randomUUID();
  const completionId = `chatcmpl-tre-${crypto.randomUUID().replace(/-/gu, '').slice(0, 20)}`;
  const wantsStream = payload.stream !== false;

  let variant: string | null = null;
  try {
    const cred = await usableCredential(account, refreshTraeCredential);
    variant = await traeVariantModelName(cred, requestedModel);
  } catch (error: any) {
    logSink(`trae 取模型变体名失败，本次按默认模型发：${error.message}`);
  }

  const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

  const callUpstream = (credential: any) =>
    fetch(`${TRAE_CHAT_BASE}${CHAT_PATH}`, {
      method: 'POST',
      headers: traeHeaders(credential),
      body: JSON.stringify(buildTraeBody(payload, sessionId, variant)),
      signal,
    });

  let credential: any;
  try {
    credential = await usableCredential(account, refreshTraeCredential);
  } catch (error: any) {
    logSink(`trae chat credential error: ${error.message}`);
    throw asCredentialError(error, 'Trae 凭据不可用') ?? new UpstreamError(502, error.message, { code: 'trae_no_credential' });
  }
  let upstream: Response;
  try {
    upstream = await callUpstream(credential);
  } catch (error: any) {
    logSink(`trae chat transport error: ${error.message}`);
    throw new UpstreamError(502, `Trae upstream transport error: ${error.message}`, { code: 'trae_transport' });
  }

  if (upstream.status === 401) {
    logSink('trae chat got 401; refreshing credential and retrying once');
    await upstream.text().catch(() => '');
    try {
      credential = await usableCredential(account, refreshTraeCredential, { forceRefresh: true });
    } catch (error: any) {
      logSink(`trae chat credential refresh error: ${error.message}`);
      throw asCredentialError(error, 'Trae 凭据不可用') ?? new UpstreamError(502, error.message, { code: 'trae_no_credential' });
    }
    try {
      upstream = await callUpstream(credential);
    } catch (error: any) {
      throw new UpstreamError(502, `Trae upstream transport error after refresh: ${error.message}`, { code: 'trae_transport' });
    }
  }

  if (!upstream.ok) {
    const text = (await upstream.text().catch(() => '')).slice(0, 2000);
    logSink(`trae chat upstream http ${upstream.status}: ${text.slice(0, 400)}`);
    throw new UpstreamError(upstream.status, `Trae upstream http ${upstream.status}: ${text}`, {
      code: `trae_${upstream.status}`,
      retryAt: retryAfterAt(upstream.headers.get('retry-after')),
    });
  }

  const splitter = frameSplitter();
  const decoder = new TextDecoder('utf-8');
  let usage: any = null;
  let upstreamError: string | null = null;
  let sawToolCall = false;
  let sawContent = false;

  const translate = (frame: string): { delta?: any; error?: string } | null => {
    const { event, data } = parseFrame(frame);
    if (event === 'error') {
      return { error: data && data.message ? String(data.message) : 'Trae upstream error' };
    }
    if (event === 'token_usage') {
      const mapped = mapTraeTokenUsage(data);
      if (mapped) usage = mapped;
      return null;
    }
    if (event !== 'output' || !data || typeof data !== 'object') return null;

    const delta: any = {};
    if (typeof data.reasoning_content === 'string' && data.reasoning_content !== '') {
      delta.reasoning_content = data.reasoning_content;
    }
    if (typeof data.response === 'string' && data.response !== '') {
      delta.content = data.response;
      sawContent = true;
    }
    if (Array.isArray(data.tool_calls) && data.tool_calls.length > 0) {
      const calls: any[] = [];
      for (const call of data.tool_calls) {
        if (!call || typeof call !== 'object') continue;
        const fn = call.function_call || call.function || {};
        const entry: any = { index: typeof call.index === 'number' ? call.index : 0 };
        if (typeof call.id === 'string' && call.id !== '') {
          entry.id = call.id;
          entry.type = 'function';
        }
        const functionDelta: any = {};
        if (typeof fn.name === 'string' && fn.name !== '') functionDelta.name = fn.name;
        if (typeof fn.arguments === 'string' && fn.arguments !== '') functionDelta.arguments = fn.arguments;
        if (Object.keys(functionDelta).length > 0) entry.function = functionDelta;
        if (entry.id || Object.keys(functionDelta).length > 0) calls.push(entry);
        if (entry.id) sawToolCall = true;
      }
      if (calls.length > 0) delta.tool_calls = calls;
    }
    return Object.keys(delta).length > 0 ? { delta } : null;
  };

  async function* frames(): AsyncGenerator<{ delta?: any; error?: string }> {
    try {
      for await (const chunk of upstream.body!) {
        for (const frame of splitter.push(decoder.decode(chunk, { stream: true }))) {
          const item = translate(frame);
          if (item) yield item;
        }
      }
      for (const frame of splitter.push(decoder.decode())) {
        const item = translate(frame);
        if (item) yield item;
      }
      for (const frame of splitter.flush()) {
        const item = translate(frame);
        if (item) yield item;
      }
    } catch (error: any) {
      logSink(`trae chat stream error: ${error.message}`);
      yield { error: error.message };
    }
  }

  const settle = (status: string) => {
    request.onUsage?.(usage);
    logSink(
      `trae chat done account=${account.id} model=${requestedModel} content=${sawContent} tools=${sawToolCall} status=${status} ${Date.now() - started}ms`,
    );
  };

  if (wantsStream) {
    const stream = (async function* (): AsyncGenerator<string> {
      let failed = false;
      for await (const item of frames()) {
        if (item.error) {
          upstreamError = item.error;
          failed = true;
          yield openAiErrorChunk(completionId, requestedModel, item.error);
          continue;
        }
        if (item.delta) yield openAiChunk(completionId, requestedModel, item.delta);
      }
      if (!failed) {
        const finishReason = sawToolCall ? 'tool_calls' : 'stop';
        yield openAiChunk(completionId, requestedModel, {}, finishReason);
        if (usage) {
          yield `data: ${JSON.stringify({
            id: completionId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: requestedModel,
            choices: [],
            usage,
          })}\n\n`;
        }
      }
      yield 'data: [DONE]\n\n';
      settle(upstreamError ? 'error' : '200');
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

  const collectedContent: string[] = [];
  const collectedReasoning: string[] = [];
  const collectedToolCalls: any[] = [];
  for await (const item of frames()) {
    if (item.error) {
      upstreamError = item.error;
      continue;
    }
    const delta = item.delta;
    if (!delta) continue;
    if (typeof delta.content === 'string') collectedContent.push(delta.content);
    if (typeof delta.reasoning_content === 'string') collectedReasoning.push(delta.reasoning_content);
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const index = typeof call.index === 'number' ? call.index : 0;
        const slot = collectedToolCalls[index] || (collectedToolCalls[index] = { id: '', type: 'function', function: { name: '', arguments: '' } });
        if (call.id) slot.id = call.id;
        if (call.function && call.function.name) slot.function.name += call.function.name;
        if (call.function && call.function.arguments) slot.function.arguments += call.function.arguments;
      }
    }
  }
  if (upstreamError) {
    logSink(`trae chat failed account=${account.id} model=${requestedModel}: ${upstreamError.slice(0, 300)}`);
    settle('error');
    throw new UpstreamError(502, upstreamError, { code: 'trae_upstream_error' });
  }
  const toolCalls = collectedToolCalls.filter(Boolean);
  const message = {
    role: 'assistant',
    content: collectedContent.join(''),
    ...(collectedReasoning.length ? { reasoning_content: collectedReasoning.join('') } : {}),
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
  const body = {
    id: completionId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [{ index: 0, message, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
    ...(usage ? { usage } : {}),
  };
  settle('200');
  return { kind: 'json', status: 200, body };
}

export async function traeModelCatalog(account: Account) {
  const credential = await usableCredential(account, refreshTraeCredential);
  const models = await fetchTraeModelConfig(credential);
  return models.map((model) => {
    const { hasMax, contextWindow, maxTokens } = effectiveLimits(model);
    return {
      id: model.id,
      name: withRateSuffix(model.name, model.rate),
      contextWindow,
      maxTokens,
      maxContext: hasMax ? model.maxContext : null,
      reasoning: model.reasoning,
      multimodal: model.multimodal,
    };
  });
}

function withRateSuffix(name: string, rate: number | null) {
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) return name;
  return `${name} · ${rate.toFixed(2)}x`;
}

export async function traeModelList(account: Account) {
  const models = await traeModelCatalog(account);
  return models.map((model) => ({
    id: model.id,
    object: 'model',
    name: model.name,
    context_length: model.contextWindow,
    max_output_tokens: model.maxTokens,
    reasoning: model.reasoning === true,
    input: model.multimodal === true ? ['text', 'image'] : ['text'],
  }));
}
