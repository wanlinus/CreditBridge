// 冒烟测试：往网关发一条 DSH 形状的对话，把流打印出来。
//
// 用法：node test/smoke-chat.mjs [模型 id]
//      不传模型 id 就用 /v1/models 返回的第一个。
//
// 前提：网关跑着，且**有一把可用的 API key**——v2 的机器凭据只有
// `data/auth/keys.json`（只存 scrypt 哈希，恢复不出明文），所以 key 必须从外部给：
//
//   $env:QB_API_KEY = 'sk-…'                     # 在网关 /keys 页建的，整串只显示一次
//   $env:QB_GATEWAY = 'http://192.168.1.100:7801'    # 可选，默认本机
//
// 没有 key 就跳过（exit 0）并说明原因——它挂在 `npm test` 里，不该让整套测试
// 变成「必须有网关 + 必须有 key 才能跑」。
//
// v1 的 `data/auth/gateway.json.token` 在 E 阶段删了，别再回去读它。

const GATEWAY = (process.env.QB_GATEWAY || 'http://192.168.1.100:7801').replace(/\/+$/u, '');
const token = process.env.QB_API_KEY || '';

if (!token) {
  console.log('跳过 smoke-chat：没有 QB_API_KEY（在网关 /keys 页建一把，再设这个环境变量）');
  process.exit(0);
}

const auth = { Authorization: `Bearer ${token}` };

/** 传了就用传的，没传就取列表第一个 —— v2 的 id 形如 `wb-1/hy4free`。 */
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

// 401/403 是配置问题（key 错了 / 还没改默认密码），不是「模型答得不好」，必须让调用方看见。
if (response.status === 401 || response.status === 403) process.exit(1);
