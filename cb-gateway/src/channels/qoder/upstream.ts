import type { Account, ChatOutcome, ChatRequest } from '../../types.ts';
import { usableCredential } from '../../core/accounts.ts';
import { asCredentialError } from '../../shared/credential-error.ts';
import { UpstreamError } from '../../shared/upstream-error.ts';
import { refreshQoderCredential } from './auth.ts';
import { getModelNames, maybeRefreshAfterChat, resolveModelName } from './models.ts';
import { runTurn, type CliEvent } from './process.ts';

const MAX_PROMPT_CHARS = 200_000;

const SUPPORTED_PARAMS = ['model', 'messages', 'stream'];
const IGNORED_PARAMS = ['temperature', 'top_p', 'stop', 'frequency_penalty', 'presence_penalty', 'max_tokens', 'n', 'seed', 'logit_bias', 'response_format', 'tools', 'tool_choice', 'parallel_tool_calls', 'user', 'store', 'metadata', 'service_tier', 'stream_options', 'logprobs', 'top_logprobs', 'modalities', 'prediction', 'reasoning_effort'];

let logSink: any = null;

export function setQoderUpstreamLogger(fn: any) {
  logSink = fn;
}

function log(...args: unknown[]) {
  if (logSink) logSink(`[qoder-upstream] ${args.join(' ')}`);
}

export function messagesToPrompt(messages: any[]): string {
  const systems: string[] = [];
  const turns: string[] = [];

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = typeof message.role === 'string' ? message.role : 'user';
    const text = contentToText(message.content);
    if (!text) continue;
    if (role === 'system' || role === 'developer') {
      systems.push(text);
      continue;
    }
    if (role === 'assistant') {
      turns.push(`[Assistant]\n${text}`);
      continue;
    }
    turns.push(`[User]\n${text}`);
  }

  const parts: string[] = [];
  if (systems.length > 0) parts.push(`[System Instructions]\n${systems.join('\n\n')}`);
  parts.push(turns.join('\n\n'));
  return parts.join('\n\n').trim();
}

function contentToText(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const pieces: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      pieces.push(part);
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    if (typeof part.text === 'string') {
      pieces.push(part.text);
      continue;
    }
    if (part.type === 'image_url' || part.type === 'image') {
      pieces.push('[图片内容：当前网关不支持多模态输入]');
    }
  }
  return pieces.join('\n');
}

function completionId() {
  return `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function deltaFromStreamEvent(event: any): { text?: string; reasoning?: string } | null {
  if (event.type !== 'stream_event') return null;
  const inner = event.event;
  if (!inner || inner.type !== 'content_block_delta') return null;
  const delta = inner.delta || {};
  if (typeof delta.text === 'string' && delta.text !== '') return { text: delta.text };
  if (typeof delta.thinking === 'string' && delta.thinking !== '') return { reasoning: delta.thinking };
  return null;
}

function textFromAssistant(event: any): string {
  if (event.type !== 'assistant') return '';
  const content = event.message && event.message.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part: any) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part: any) => part.text)
    .join('');
}

export async function chatQoder(account: Account, request: ChatRequest): Promise<ChatOutcome> {
  const started = Date.now();
  const payload = request.body;

  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  if (messages.length === 0) {
    throw new UpstreamError(400, 'messages 不能为空', { code: 'qoder_empty_messages' });
  }

  const prompt = messagesToPrompt(messages);
  if (prompt === '') {
    throw new UpstreamError(400, 'messages 里没有任何可用文本', { code: 'qoder_empty_prompt' });
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new UpstreamError(
      400,
      `prompt 过长（${prompt.length} 字符），上限 ${MAX_PROMPT_CHARS}。` +
        'Qoder 对超长输入不报错但会消耗大量积分，所以网关强制截断请求。',
      { code: 'qoder_prompt_too_long' },
    );
  }

  const requestedModel = typeof payload.model === 'string' ? payload.model : '';
  let model = '';
  let knownModels: string[] = [];
  try {
    knownModels = await getModelNames();
  } catch (error: any) {
    log(`取模型名单失败，跳过模型校验：${error.message}`);
  }
  if (requestedModel !== '') {
    if (knownModels.length > 0) {
      const resolved = resolveModelName(requestedModel, knownModels);
      if (!resolved) {
        throw new UpstreamError(400, `未知模型 "${requestedModel}"。当前可用：${knownModels.join(', ')}`, {
          code: 'qoder_unknown_model',
        });
      }
      model = resolved;
    } else {
      model = requestedModel;
    }
  } else if (knownModels.length > 0) {
    model = knownModels[0];
  } else {
    model = 'Auto';
  }

  try {
    await usableCredential(account, refreshQoderCredential);
  } catch (error: any) {
    throw asCredentialError(error, 'Qoder 凭据不可用') ?? new UpstreamError(502, error.message, { code: 'qoder_no_credential' });
  }

  const wantsStream = payload.stream !== false;
  const ignored = Object.keys(payload).filter((key) => IGNORED_PARAMS.includes(key));
  const unknown = Object.keys(payload).filter((key) => !IGNORED_PARAMS.includes(key) && !SUPPORTED_PARAMS.includes(key));

  log(
    `chat start account=${account.id} model=${model}${requestedModel && requestedModel !== model ? ` (requested ${requestedModel})` : ''} ` +
      `messages=${messages.length} promptChars=${prompt.length} stream=${wantsStream}` +
      (ignored.length > 0 ? ` ignored=${ignored.join(',')}` : '') +
      (unknown.length > 0 ? ` unknown=${unknown.join(',')}` : ''),
  );

  const id = completionId();
  const created = Math.floor(Date.now() / 1000);

  const finish = (usage: any, status: number) => {
    request.onUsage?.(usage);
    maybeRefreshAfterChat();
    log(`chat done account=${account.id} model=${model} status=${status} credits=${usage?.credit ?? 0} ${Date.now() - started}ms`);
  };

  if (wantsStream) {
    const queue: string[] = [];
    let finished = false;
    const waiter: { wake: (() => void) | null } = { wake: null };
    const push = (text: string) => {
      queue.push(text);
      const wake = waiter.wake;
      waiter.wake = null;
      wake?.();
    };

    const task = (async () => {
      try {
        const { result, credits } = await runTurn(prompt, { model }, (event: CliEvent) => {
          const delta = deltaFromStreamEvent(event);
          if (!delta) return;
          push(
            sseFrame({
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: delta.text !== undefined ? { content: delta.text } : { reasoning_content: delta.reasoning },
                  finish_reason: null,
                },
              ],
            }),
          );
        });
        const finishReason = result && result.is_error === true ? 'error' : 'stop';
        if (unknown.length > 0) log(`客户端传了网关不认识的字段，已忽略：${unknown.join(',')}`);
        push(sseFrame({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }));
        push(
          sseFrame({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [],
            usage: { credit: credits },
          }),
        );
        push('data: [DONE]\n\n');
        finish({ credit: credits }, 200);
      } catch (error: any) {
        log(`chat ${model} 失败：${error.message}`);
        push(sseFrame({ error: { message: error.message, type: 'gateway_error', code: 'qoder_upstream_error' } }));
        push('data: [DONE]\n\n');
        finish(null, 502);
      } finally {
        finished = true;
        const wake = waiter.wake;
        waiter.wake = null;
        wake?.();
      }
    })();
    void task;

    const stream = (async function* (): AsyncGenerator<string> {
      yield sseFrame({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      });
      while (true) {
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

  let text = '';
  const reasoning: string[] = [];
  try {
    const { result, credits } = await runTurn(prompt, { model }, (event: CliEvent) => {
      const chunk = textFromAssistant(event);
      if (chunk) text = chunk;
      const delta = deltaFromStreamEvent(event);
      if (delta && delta.reasoning) reasoning.push(delta.reasoning);
    });
    if (!text && result && typeof result.result === 'string') text = result.result;
    finish({ credit: credits }, 200);
    return {
      kind: 'json',
      status: 200,
      body: {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: text,
              ...(reasoning.length > 0 ? { reasoning_content: reasoning.join('') } : {}),
            },
            finish_reason: 'stop',
          },
        ],
        usage: { credit: credits },
      },
    };
  } catch (error: any) {
    log(`chat ${model} 失败：${error.message}`);
    finish(null, 502);
    throw new UpstreamError(502, error.message, { code: 'qoder_upstream_error' });
  }
}

function sseFrame(payload: any): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}
