export function usageFromSseLine(line: any) {
  if (!line.startsWith('data:')) return null;
  const data = line.slice(5).trim();
  if (!data || data === '[DONE]') return null;
  try {
    const chunk = JSON.parse(data);
    return chunk && chunk.usage ? chunk.usage : null;
  } catch {
    return null;
  }
}

export function aggregateSse(text: any) {
  const content = [];
  const reasoning = [];
  const toolCalls = [];
  let id = '';
  let model = '';
  let finish = null;
  let usage = null;
  for (const line of text.split(/\r?\n/u)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let chunk;
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
