// Trae CN → OpenAI 协议适配层。
//
// DSH 说的是 OpenAI Chat Completions。Trae 的私有 agent 端点
// （`POST /api/agent/v3/llm_utils_chat`，带 `function: "chat_v3"`）说的是另一种
// 相似但不相同的方言，响应还是 Trae 自己的 SSE 事件流、而不是 OpenAI chunk。
// 两个方向的翻译都由本模块负责。
//
// 以下线上事实已对 Trae CN 3.3.104 实测：
//   * `tools[].function.parameters` 必须是 JSON **字符串**，不能是对象。
//     传对象会被回 400「cannot unmarshal object ... of type string」。
//   * 工具调用是按块流式下发的，块里带 `function_call: { name, arguments }`：
//     第一块给出函数名，后续块追加 `arguments` 片段。
//   * 回放工具调用时必须沿用 `function_call` 这个字段名——用 OpenAI 的拼法
//     `function` 会被拒绝，表现为流读取错误。
//   * 每个 `messages[].content` 都必须是内容分片数组
//     （`[{ type: "text", text }]`），`role: "tool"` 的结果也不例外。
//   * 响应事件类型：`output`（response / reasoning_content / tool_calls）、
//     `token_usage`、`extra_info`、`done`、`error`。

import crypto from 'node:crypto';

import type { Account, ChatOutcome, ChatRequest } from '../../types.ts';
import { usableCredential } from '../../core/accounts.ts';
import { UpstreamError, retryAfterAt } from '../../shared/upstream-error.ts';
import { asCredentialError } from '../../shared/credential-error.ts';
import { TRAE_CHAT_BASE, refreshTraeCredential, traeHeaders } from './auth.ts';
import { traeVariantModelName } from './models.ts';

/**
 * 模块级日志出口。`log` 在流式函数里是参数，但 `traeVariantModelName()` 没有那个
 * 上下文，所以给它单独一根线——由通道在 `configure()` 里接到网关的 logger 上。
 */
let logSink: any = null;
export function setTraeUpstreamLogger(fn: any) {
  logSink = fn;
}
function log(...args: unknown[]) {
  if (logSink) logSink(`[trae-upstream] ${args.join(' ')}`);
}

const CHAT_PATH = '/api/agent/v3/llm_utils_chat';
const UPSTREAM_TIMEOUT_MS = 600000;

/**
 * Trae 的思考档位是 light / high / extra_high，和 OpenAI 的 `reasoning_effort`
 * 不是一套，所以这里显式映射，不做透传。
 */
function mapReasoningLevel(effort: any) {
  if (effort === undefined || effort === null || effort === '') return 'high';
  const value = String(effort).toLowerCase();
  if (value === 'off' || value === 'none' || value === 'minimal' || value === 'low' || value === 'light') return 'light';
  if (value === 'xhigh' || value === 'max' || value === 'extra_high') return 'extra_high';
  return 'high';
}

/**
 * Trae 认模型的**唯一**正确姿势：顶层 `config_name` + `model_name`（带 `__dev`/`__max` 后缀）。
 *
 * 2026-11-10 实测的三种写法：
 *
 *   · 只发 `model: "glm-5.3"`（网关原来的做法）→ 服务端**忽略模型**，落到账号默认模型
 *     （`ep-20260824142627-mcvh6`，自称豆包），23 万 token 就 4026；
 *   · 顶层 `config_name` + 裸 `model_name: "glm-5.3"` → `4023 model is unknown`；
 *   · 顶层 `config_name` + `model_name: "deepseek-v4.1-flash__max"` → 路由到该模型自己的
 *     endpoint，49 万 token 正常返回。
 *
 * 所以顶层的 `config_name` / `model_name` 才是生效的那一份；`custom_model` 里照抄
 * 客户端的 `model_info` 形状（同样带这两个字段），服务端不看那一份，但跟着官方发
 * 更像真客户端，免得被指纹识别。拿不到变体名（配置接口挂了）时不发这两个字段，
 * 退回老形状：至少能用默认模型。
 */
function modelSelector(model: string, variant: string | null) {
  return variant ? { config_name: model, model_name: variant } : {};
}

/**
 * 取出上游模型名（只做类型收窄，**不做别名翻译**）。
 *
 * 模型名对不对不在这里判断：`chatTrae()` 拿实时配置去核（`traeVariantModelName`），
 * 核不到就不发 `config_name`/`model_name`，服务端用账号默认模型。
 *
 * **不要加回别名映射表**：v2 的模型 id 必须写成 `tr-3/glm-5.3`，无前缀的名字在
 * `resolveModel()` 就 404 了，正常客户端拿到的 id 来自 `/v1/models`，里面只会有
 * 上游真名。那种表是第二份会过期的模型映射，它烂过一次。
 */
function traeModelName(requested: unknown) {
  return typeof requested === 'string' ? requested : '';
}

/**
 * 从 OpenAI 风格的 content 分片里取出图片 URL。
 *
 * Trae 只认一种图片形状（拿 64x64 红色 PNG 验过：模型答"红色"）：
 *
 *   { type: "image_url", image_url: { url: "data:image/png;base64,..." } }
 *
 * 其它写法（裸 `url`、`data`+`media_type`、Anthropic 的 `source`、
 * `image`/`base64` 键）一律回 4001 "param is invalid"，错误里提到的 Go 类型叫
 * `idecopilot.LLMRawMessageImageUrl`。下面几个分支是**兜底转换**，不是上游认的形状。
 */
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

/** 把 OpenAI 的 content 值摊平成 Trae 的 content 分片数组。 */
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

/** 把回放的 assistant tool_calls 数组转成 Trae 的 `function_call` 形状。 */
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

/** 把 OpenAI 的工具列表转成 Trae 的，并把 `parameters` 序列化成字符串。 */
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

/**
 * 用 OpenAI 的 chat-completions 请求体拼出 Trae 的请求体。
 * `sessionId` 让同一段对话的轮次落在上游同一个会话里。
 * `variant` 是带 `__max`/`__dev` 后缀的上游模型名，见 `modelSelector()`。
 */
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

    // Trae 没有 `developer` 角色。
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
  // `multimodal` 是能力声明，不是闸门：带图片的请求无论开不开都能成功。
  // 如实上报，让 Trae 那边看到它实际收到的是什么。
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

/** 把裸 SSE 字节流按空行切成帧。 */
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

/** 把一帧 SSE 解析成 `{ event, data }`。 */
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

/**
 * Trae 的 `token_usage` 事件 → OpenAI 形状的 usage。
 *
 * **缓存字段必须做字段名映射，不能只做放行。** Trae 的原生字段名是
 * `cache_read_input_tokens` / `cache_creation_input_tokens`，而 pi-ai 的
 * `parseChunkUsage` 只认 `prompt_tokens_details.cached_tokens` /
 * `prompt_tokens_details.cache_write_tokens`（另有 `prompt_cache_hit_tokens`、
 * 顶层 `cached_tokens` 两个别名拼写）。原样透传上游字段名，DSH 侧一律读不到，
 * 界面上的「缓存命中」会恒为 0——看起来像上游没缓存，实际是中间这一层把字段名丢了。
 *
 * **口径是 OpenAI 口径**：证据是同一份 prompt 连发两次时，`prompt_tokens` 恒为 9224
 * 而 `cache_read_input_tokens` 从 5248 涨到 9216——若 `prompt_tokens` 不含缓存，同一份
 * 输入的实际规模就要从 14472 涨到 18440，不成立。完整捕获（含原始 `token_usage` 原文）
 * 见同类实现 dsh-connect-trae 的 `docs/ISSUE10_DIAGNOSIS.md`。
 * pi-ai 会做 `input = prompt_tokens - cacheRead - cacheWrite`，所以直接映射算术正确。
 * 上游哪天改成 Anthropic 口径（input 已排除缓存），这里必须跟着改，否则重复扣减。
 *
 * 上游没给缓存字段时**不产生** `prompt_tokens_details`：凭空塞一个
 * `cached_tokens: 0` 会把「上游没报这个数」说成「上游报了 0」，那是另一件事。
 */
export function mapTraeTokenUsage(data: any): any | null {
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.prompt_tokens !== 'number') {
    return null;
  }
  // 负数 / NaN 一律当成「上游没说」：混进 usage 会让 pi-ai 的减法算出负的 input。
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

/**
 * 把一次对话补全转发给 Trae，再按 OpenAI 形状吐回来。
 *
 * 流式给一个 async generator、非流式给聚合好的 JSON，失败抛 `UpstreamError` 让路由层
 * 改账号状态——通道不碰 HTTP 响应。
 *
 * **Trae 不回报单次请求花了多少积分**（token 数它报），所以账本里 `credit` 恒为
 * `null`。积分只读官方余额（`creditsOf`），不做逐请求结算——见
 * private/docs/v3/overview-redesign.md。
 */
export async function chatTrae(account: Account, request: ChatRequest): Promise<ChatOutcome> {
  const started = Date.now();
  const payload = request.body;
  const requestedModel = traeModelName(payload.model);
  const sessionId = crypto.randomUUID();
  const completionId = `chatcmpl-tre-${crypto.randomUUID().replace(/-/gu, '').slice(0, 20)}`;
  const wantsStream = payload.stream !== false;

  // 上游模型名（带 `__max`/`__dev` 后缀）。取不到就当没有——退回默认模型，
  // 至少请求能成，只是「选哪个模型」不生效（见 modelSelector 的说明）。
  let variant: string | null = null;
  try {
    const cred = await usableCredential(account, refreshTraeCredential);
    variant = await traeVariantModelName(cred, requestedModel);
  } catch (error: any) {
    log(`trae 取模型变体名失败，本次按默认模型发：${error.message}`);
  }

  // 客户端断开就掐掉上游；没给信号时按 10 分钟兜底。
  const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

  // body 每次现建：`buildTraeBody` 里带了时间戳一类的字段，重试时复用会带上旧值。
  const callUpstream = (credential: any) =>
    fetch(`${TRAE_CHAT_BASE}${CHAT_PATH}`, {
      method: 'POST',
      headers: traeHeaders(credential),
      body: JSON.stringify(buildTraeBody(payload, sessionId, variant)),
      signal,
    });

  // 凭据拿不到就直接抛，而且保留 `permanent`——裸 Error 冒到路由层会被当成默认 502，
  // 而 502 不改账号状态，于是过期的号永远显示「就绪」。
  let credential: any;
  try {
    credential = await usableCredential(account, refreshTraeCredential);
  } catch (error: any) {
    log(`trae chat credential error: ${error.message}`);
    throw asCredentialError(error, 'Trae 凭据不可用') ?? new UpstreamError(502, error.message, { code: 'trae_no_credential' });
  }
  let upstream: Response;
  try {
    upstream = await callUpstream(credential);
  } catch (error: any) {
    log(`trae chat transport error: ${error.message}`);
    throw new UpstreamError(502, `Trae upstream transport error: ${error.message}`, { code: 'trae_transport' });
  }

  if (upstream.status === 401) {
    log('trae chat got 401; refreshing credential and retrying once');
    await upstream.text().catch(() => '');
    // 必须强制刷新：本地有效期没到时，读回来的还是同一枚被拒的令牌。
    try {
      credential = await usableCredential(account, refreshTraeCredential, { forceRefresh: true });
    } catch (error: any) {
      log(`trae chat credential refresh error: ${error.message}`);
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
    log(`trae chat upstream http ${upstream.status}: ${text.slice(0, 400)}`);
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

  /**
   * Trae 的 SSE 事件 → OpenAI delta。
   *
   * 这段规则只写一份，流式和非流式共用——两边各写一遍的话，改一处忘一处，表现是
   * 「流式正常、非流式少一段 content」这种很难查的不一致。
   */
  const translate = (frame: string): { delta?: any; error?: string } | null => {
    const { event, data } = parseFrame(frame);
    if (event === 'error') {
      return { error: data && data.message ? String(data.message) : 'Trae upstream error' };
    }
    if (event === 'token_usage') {
      // 映射逻辑抽成 `mapTraeTokenUsage`：它是纯函数，能被测试直接喂真实 payload，
      // 不用起假上游。缓存字段的坑（字段名不对就静默为 0）正是靠那条测试钉住的。
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

  /** 读上游的帧并翻译。只会被下面两个分支里的一个消费，不会重复读流。 */
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
      log(`trae chat stream error: ${error.message}`);
      yield { error: error.message };
    }
  }

  /** 记账回调 + 收尾日志。`usage` 里没有 `credit`——Trae 不报单次积分。 */
  const settle = (status: string) => {
    request.onUsage?.(usage);
    log(
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
          // 头早就发出去了，只能往流里写一个 error 帧再断——不能改成 500。
          yield openAiErrorChunk(completionId, requestedModel, item.error);
          continue;
        }
        if (item.delta) yield openAiChunk(completionId, requestedModel, item.delta);
      }
      if (!failed) {
        const finishReason = sawToolCall ? 'tool_calls' : 'stop';
        // 按 OpenAI 的标准顺序：先 finish 帧，再是 `choices` 为空的 usage 帧，
        // 最后是哨兵。
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

  // 非流式：上游只肯流式返回，所以完整 JSON 是在这里聚合出来的。
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
    // 这里还没往客户端写过一个字节，所以能老老实实回 502（v1 因为已经写了头，
    // 只能回 200 加一个 error body，这一点在 v2 顺手修掉了）。
    log(`trae chat failed account=${account.id} model=${requestedModel}: ${upstreamError.slice(0, 300)}`);
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
