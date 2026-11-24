// Loomy 自助登录：短信验证码两步交互（手机号 → 验证码），不是「开浏览器等回调」。
// `onPrompt` 是登录任务层提供的通用交互口子：前端轮询到 `prompt` 就渲染表单，用户提交后 resolve。
// 网关自己**不开任何端口、不碰浏览器**；session 14 天过期、无 refresh token，到期只能重走这条流程。

import { pathToFileURL } from 'node:url';

import type { LoginResult } from '../../types.ts';
import { fetchUserInfo, sendSmsCode, SESSION_TTL_MS, verifySmsCode } from './auth.ts';

/**
 * 跑一次短信登录。`onPrompt` 会被先后调两次（手机号 → 验证码），每次返回的 promise 在用户
 * 提交后 resolve、取消登录时 reject（由登录任务层在 abort 时触发）。
 */
export async function runLoomyLogin(
  options: { onPrompt?: (prompt: any) => Promise<string>; signal?: AbortSignal } = {},
): Promise<LoginResult> {
  const ask = options.onPrompt;
  if (typeof ask !== 'function') {
    throw new Error('Loomy 登录需要表单交互（onPrompt），请通过网关账号页发起');
  }

  // ① 手机号
  const phone = (await ask({
    id: 'phone',
    label: '输入手机号',
    placeholder: '中国大陆手机号（1 开头 11 位）',
    inputType: 'text',
    submitLabel: '发送验证码',
  })).trim();
  if (!phone) throw new Error('未输入手机号');

  const msgid = await sendSmsCode(phone);

  // ② 验证码
  const code = (await ask({
    id: 'code',
    label: '输入短信验证码',
    placeholder: '6 位验证码',
    inputType: 'number',
    submitLabel: '登录',
  })).trim();
  if (!code) throw new Error('未输入验证码');

  const { session, userId } = await verifySmsCode(phone, code, msgid);

  // ③ 昵称（失败不致命）
  const profile = await fetchUserInfo(session);

  const credential = {
    session,
    userId,
    phone,
    expiresAt: Date.now() + SESSION_TTL_MS,
    source: 'login',
  };

  const username = profile?.username || '';
  return {
    credential,
    profile: {
      uid: userId,
      username,
    },
    label: username || `手机号 ${phone.slice(0, 3)}****${phone.slice(-4)}`,
  };
}

// 直接 `node src/channels/loomy/login.ts` 时执行；被 channel.login() import 时不执行。
const entry = process.argv[1];
const isMain = entry ? import.meta.url === pathToFileURL(entry).href : false;
if (isMain) {
  // CLI 直跑没有前端表单，只能用「终端读输入」兜底，方便手工验证协议。
  const readline = (await import('node:readline')).createInterface({ input: process.stdin, output: process.stdout });
  const ask = (prompt: any) =>
    new Promise<string>((resolve) => readline.question(`${prompt.label}：`, (answer: string) => resolve(answer)));
  runLoomyLogin({ onPrompt: ask })
    .then(() => console.log('登录成功'))
    .catch((error) => {
      console.error(`\n登录失败：${error && error.message ? error.message : error}`);
      process.exitCode = 1;
    })
    .finally(() => readline.close());
}
