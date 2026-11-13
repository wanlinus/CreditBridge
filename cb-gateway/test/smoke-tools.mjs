const model = process.argv[2] || 'hy3';
const url = 'http://127.0.0.1:7801/workbuddy/v1/chat/completions';

const body = {
  model,
  stream: true,
  messages: [
    { role: 'system', content: 'You are an AI agent powered by DeepSeek Harness. Use tools when asked.' },
    { role: 'user', content: '请调用 get_weather 工具查询北京今天的天气。只调用工具，不要解释。' },
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: '查询指定城市的天气',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string', description: '城市名' } },
          required: ['city'],
        },
      },
    },
  ],
  tool_choice: 'auto',
  max_tokens: 256,
};

const response = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

console.log('status', response.status);
const text = await response.text();
const calls = [];
let finish = '';
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
  const choice = chunk.choices && chunk.choices[0];
  if (!choice) continue;
  if (choice.finish_reason) finish = choice.finish_reason;
  if (Array.isArray(choice.delta?.tool_calls)) calls.push(...choice.delta.tool_calls);
}
console.log('finish_reason', finish || '(none)');
console.log('tool_calls seen', calls.length);
for (const call of calls.slice(0, 6)) {
  console.log(JSON.stringify({ index: call.index, id: call.id, name: call.function?.name, args: call.function?.arguments }));
}
if (calls.length === 0) console.log('RAW HEAD:', text.slice(0, 1200));
