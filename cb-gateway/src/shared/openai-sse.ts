// OpenAI 形状的 SSE 工具。
//
// WorkBuddy 和 Loomy 的上游回的就是 OpenAI chunk 格式（原样透传），所以这两个读取
// 函数共用，而不是每个通道抄一份。Trae 是自己**合成** OpenAI chunk 的，它的解析在
// `channels/trae/upstream.ts` 里，不走这里——别把「输出是 OpenAI 形状」和「用这份
// 工具解析」混成一回事。
//
// ## 参数类型为什么收紧了（2026-11-22）
//
// 这两个函数原来的签名是 `(line: any)` / `(text: any)`。`any` 的代价在这里很具体：
// 传错一个非字符串（比如把一个 chunk 对象传进来）不会报错，`line.startsWith` 直接抛
// `TypeError`，而调用点在流的读取循环里——那个异常会被当成「上游挂了」，记成 502。
//
// 收成 `string` 之后，同样的错误在**类型检查时**就暴露。

import type { ChatUsage } from '../types.ts';

/**
 * 从一行 SSE 里捞出最后一个 `usage` 对象（有的话）。
 *
 * 返回 `null` 的三种情况都是正常的，不是错误：心跳行、`[DONE]`、被拆在两次读取之间
 * 的半截帧（解析失败）。
 */
export function usageFromSseLine(line: string): ChatUsage | null {
  if (!line.startsWith('data:')) return null;
  const data = line.slice(5).trim();
  if (!data || data === '[DONE]') return null;
  try {
    const chunk = JSON.parse(data);
    return chunk && chunk.usage ? (chunk.usage as ChatUsage) : null;
  } catch {
    return null; // 心跳，或者一帧被拆在两次读取里
  }
}

/** `aggregateSse()` 的输出：一个 OpenAI `chat.completion` 对象。 */
export interface AggregatedCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: 'assistant';
      content: string;
      reasoning_content?: string;
      tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
    };
    finish_reason: string;
  }[];
  usage: ChatUsage | null;
}

/** 把完整的 SSE 响应体折成一个 OpenAI `chat.completion` 对象。 */
export function aggregateSse(text: string): AggregatedCompletion {
  const content: string[] = [];
  const reasoning: string[] = [];
  const toolCalls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] = [];
  let id = '';
  let model = '';
  let finish: string | null = null;
  let usage: ChatUsage | null = null;

  for (const line of text.split(/\r?\n/u)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.id) id = chunk.id;
    if (chunk.model) model = chunk.model;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices && chunk.choices[0];
    if (!choice) continue;
    if (choice.finish_reason) finish = choice.finish_reason;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string') content.push(delta.content);
    if (typeof delta.reasoning_content === 'string') reasoning.push(delta.reasoning_content);
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const index = typeof call.index === 'number' ? call.index : 0;
        if (!toolCalls[index]) toolCalls[index] = { id: call.id || '', type: 'function', function: { name: '', arguments: '' } };
        if (call.id) toolCalls[index].id = call.id;
        if (call.function?.name) toolCalls[index].function.name += call.function.name;
        if (call.function?.arguments) toolCalls[index].function.arguments += call.function.arguments;
      }
    }
  }

  return {
    id: id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: content.join(''),
          ...(reasoning.length ? { reasoning_content: reasoning.join('') } : {}),
          ...(toolCalls.length ? { tool_calls: toolCalls.filter(Boolean) } : {}),
        },
        finish_reason: finish || 'stop',
      },
    ],
    usage,
  };
}
