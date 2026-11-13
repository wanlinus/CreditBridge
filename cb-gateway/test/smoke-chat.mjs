const GATEWAY = (process.env.QB_GATEWAY || 'http://10.0.0.45:7801').replace(/\/+$/u, '');
const token = process.env.QB_API_KEY || '';

if (!token) {
  console.log('跳过 smoke-chat：没有 QB_API_KEY（在网关 /keys 页建一把，再设这个环境变量）');
  process.exit(0);
}

const auth = { Authorization: `Bearer ${token}` };

async function pickModel() {
  if (process.argv[2]) return process.argv[2];
  const response = await fetch(`${GATEWAY}/v1/models`, { headers: auth });
  if (!response.ok) throw new Error(`/v1/models 回 ${response.status}`);
  const doc = await response.json();
  const first = doc?.data?.[0]?.id;
  if (!first) throw new Error('/v1/models 是空的：先去 /accounts 加账号并登录');
  return first;
}

let model;
try {
  model = await pickModel();
} catch (error) {
  console.error(`跳过 smoke-chat：${error.message}`);
  process.exit(0);
}

console.log(`网关 ${GATEWAY} · 模型 ${model}`);

const body = {
  model,
  stream: true,
  messages: [
    {
      role: 'system',
      content:
        'You are an AI agent powered by the harness. ' +
        'Tokens prefixed with @ are paths the user mentioned. ' +
        'relative paths resolve against the workspace root; absolute paths identify files on the host.',
    },
    { role: 'user', content: '用一句话回答：1 + 1 等于几？' },
  ],
  max_tokens: 128,
};

const response = await fetch(`${GATEWAY}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...auth },
  body: JSON.stringify(body),
});

console.log('status', response.status, 'content-type', response.headers.get('content-type'));
const text = await response.text();
console.log('bytes', text.length);
console.log(text.slice(0, 2500));

if (response.status === 401 || response.status === 403) process.exit(1);
