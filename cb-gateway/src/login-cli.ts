// 统一的登录入口：`npm run login -- <通道 id>`。
//
// 登录是交互式的（开浏览器、等人操作，最长 5 分钟），所以网关那边做成了「后台任务 +
// 前端轮询」，这里则是阻塞式的一次性 CLI。想知道哪个通道支持自助登录，看它有没有
// 实现 `Channel.login`。
//
// 和网关里那条路走的是同一个出口（`materializeAccount`）：凭据落成哪个账号、要不要
// 复用已有的号，两边必须一致，否则「CLI 登了两次」和「网页登了两次」会留下两种结果。

import { channelById, channels } from './channels/index.ts';
import { loadAccounts } from './core/accounts.ts';
import { materializeAccount } from './core/login-tasks.ts';
import { configureLogger } from './logger.ts';

configureLogger({ verbose: false });
loadAccounts();

const id = process.argv[2];
const channel = id ? channelById(id) : channels.find((entry) => typeof entry.login === 'function');

if (!channel) {
  console.error(`未知通道：${id}。可选：${channels.map((entry) => entry.id).join(', ')}`);
  process.exit(1);
}

if (typeof channel.login !== 'function') {
  console.error(`通道 ${channel.id} 不支持自助登录——它只能靠对应的桌面客户端登录一次。`);
  process.exit(1);
}

// 登录流程里会用到通道自己的日志出口（版本号、上游返回的提示），先接上。
channel.configure?.({ log: console.log, config: (await import('./config.ts')).config });

console.log(`开始登录通道：${channel.id}（${channel.label}）`);

// 表单式登录（Loomy 短信验证码）没有浏览器回调，改用终端读输入兜底。
// URL 式登录（WorkBuddy / Trae / Qoder）不用 onPrompt，传入也无妨。
const readline = (await import('node:readline')).createInterface({ input: process.stdin, output: process.stdout });
const onPrompt = (prompt: any) =>
  new Promise<string>((resolve) => readline.question(`${prompt.label}：`, (answer: string) => resolve(answer)));

const result = await channel.login({ onPrompt });
readline.close();
const account = materializeAccount(channel, result);

if (!account) {
  console.error('\n登录拿到了凭据，但没能落成账号。请检查 data/ 的写权限（账号现在存在 gateway.db 里）。');
  process.exit(1);
}
console.log('\n账号已更新');
console.log('  账号 id  : ' + account.id);
console.log('  显示名   : ' + account.label);
console.log('  上游账号 : ' + (account.profile?.username || account.profile?.uid || '(未知)'));
console.log('\n重启网关（或在管理台刷新）后生效。');
