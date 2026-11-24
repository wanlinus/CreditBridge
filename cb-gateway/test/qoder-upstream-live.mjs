/**
 * 端到端验证：通过**真实的 chatQoder 函数**完成一次对话。
 *
 * 这不是单元测试，是「整条链路通不通」的判定。它走：
 *   凭据里的 dt- → 现算 userInfo → 签名 → 上游 SSE → 解析帧 → 返回 SSE
 *
 * 全程**不读 `data/cli/`**（那个目录可能根本不存在）。
 *
 * ## 跑法
 *
 *   node test/qoder-upstream-live.mjs
 *
 * 会真的打上游、消耗少量积分，不能进 `npm test`。
 *
 * ## 凭据从哪来
 *
 * 网关数据库里的 qd-1；没有就跳过。也要 `QB_GATEWAY_DB` 指到别的库时能覆盖。
 */
import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.QB_GATEWAY_DB || path.join(import.meta.dirname, '..', 'data', 'gateway.db');
if (!fs.existsSync(DB_PATH)) {
  console.log(`跳过：找不到网关数据库 ${DB_PATH}`);
  process.exit(0);
}

let credential = null;
try {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const row = db.prepare("select credential from account where id = 'qd-1'").get();
  db.close();
  if (row?.credential) credential = JSON.parse(row.credential);
} catch (e) {
  console.log(`跳过：读不到 qd-1 凭据（${e.message.slice(0, 80)}）`);
  process.exit(0);
}

if (!credential?.token || !credential?.userId) {
  console.log('跳过：qd-1 凭据里没有 token 或 userId');
  process.exit(0);
}

const { chatQoder } = await import('../src/channels/qoder/upstream.ts');

const account = {
  id: 'qd-1',
  channelId: 'qoder',
  seq: 1,
  label: 'test',
  credential,
  status: 'ready',
  cooldownUntil: null,
  statusMessage: null,
};

let capturedUsage = null;
const request = {
  body: {
    model: 'auto',
    stream: true,
    messages: [
      { role: 'system', content: '只回答一个单词，不要解释。' },
      { role: 'user', content: '你记得的暗号是 PINEAPPLE。' },
      { role: 'assistant', content: '好的。' },
      { role: 'user', content: '暗号是什么？只回答那个词。' },
    ],
  },
  onUsage: (u) => {
    capturedUsage = u;
  },
};

console.log('=== 流式对话（凭据里 userInfo:', credential.userInfo ? '有' : '无（现场现算）', '）===');
const outcome = await chatQoder(account, request, 'qd');

console.log('返回形态:', outcome.kind, '状态:', outcome.status);
if (outcome.kind !== 'stream') {
  console.log('非流式响应:', JSON.stringify(outcome.body).slice(0, 300));
  process.exit(1);
}

let raw = '';
for await (const frame of outcome.body) raw += frame;

const frames = raw.split('\n\n').filter((s) => s.trim().startsWith('data:'));
console.log('SSE 帧数:', frames.length);

let text = '';
let reasoning = '';
let sawFirstRole = false;
let sawDone = false;
let sawError = null;

for (const frame of frames) {
  const payload = frame.replace(/^data:\s*/, '').trim();
  if (payload === '[DONE]') {
    sawDone = true;
    continue;
  }
  let obj;
  try {
    obj = JSON.parse(payload);
  } catch {
    continue;
  }
  if (obj.error) {
    sawError = obj.error;
    continue;
  }
  const delta = obj.choices?.[0]?.delta;
  if (delta?.role === 'assistant') sawFirstRole = true;
  if (delta?.content) text += delta.content;
  if (delta?.reasoning_content) reasoning += delta.reasoning_content;
}

console.log('\n=== 结果 ===');
console.log('首帧带 role:', sawFirstRole);
console.log('收到 [DONE]:', sawDone);
console.log('错误:', sawError ? JSON.stringify(sawError) : '(无)');
console.log('content:', JSON.stringify(text));
console.log('reasoning 长度:', reasoning.length);
console.log('\n=== usage（CLI 时代拿不到这个）===');
console.log(JSON.stringify(capturedUsage, null, 2));

const ok =
  sawFirstRole &&
  sawDone &&
  !sawError &&
  text.trim().length > 0 &&
  capturedUsage &&
  typeof capturedUsage.prompt_tokens === 'number' &&
  typeof capturedUsage.completion_tokens === 'number';

if (ok) {
  console.log('\n✓ 通过：真实对话跑通，且拿到 token 用量');
  process.exit(0);
}
console.log('\n✗ 失败');
process.exit(1);
