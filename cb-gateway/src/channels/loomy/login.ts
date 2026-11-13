import { pathToFileURL } from 'node:url';

import type { LoginResult } from '../../types.ts';
import { fetchUserInfo, sendSmsCode, SESSION_TTL_MS, verifySmsCode } from './auth.ts';

export async function runLoomyLogin(
  options: { onPrompt?: (prompt: any) => Promise<string>; signal?: AbortSignal } = {},
): Promise<LoginResult> {
  const ask = options.onPrompt;
  if (typeof ask !== 'function') {
    throw new Error('Loomy 登录需要表单交互（onPrompt），请通过网关账号页发起');
  }

  const phone = (await ask({
    id: 'phone',
    label: '输入手机号',
    placeholder: '中国大陆手机号（1 开头 11 位）',
    inputType: 'text',
    submitLabel: '发送验证码',
  })).trim();
  if (!phone) throw new Error('未输入手机号');

  const msgid = await sendSmsCode(phone);

  const code = (await ask({
    id: 'code',
    label: '输入短信验证码',
    placeholder: '6 位验证码',
    inputType: 'number',
    submitLabel: '登录',
  })).trim();
  if (!code) throw new Error('未输入验证码');

  const { session, userId } = await verifySmsCode(phone, code, msgid);

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

const entry = process.argv[1];
const isMain = entry ? import.meta.url === pathToFileURL(entry).href : false;
if (isMain) {
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
