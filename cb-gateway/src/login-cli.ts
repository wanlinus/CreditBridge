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

channel.configure?.({ log: console.log, config: (await import('./config.ts')).config });

console.log(`开始登录通道：${channel.id}（${channel.label}）`);

const readline = (await import('node:readline')).createInterface({ input: process.stdin, output: process.stdout });
const onPrompt = (prompt: any) =>
  new Promise<string>((resolve) => readline.question(`${prompt.label}：`, (answer: string) => resolve(answer)));

const result = await channel.login({ onPrompt });
readline.close();
const account = materializeAccount(channel, result);

if (!account) {
  console.error('\n登录拿到了凭据，但没能落成账号。请检查 data/accounts/ 的写权限。');
  process.exit(1);
}
console.log('\n账号已更新');
console.log('  账号 id  : ' + account.id);
console.log('  显示名   : ' + account.label);
console.log('  上游账号 : ' + (account.profile?.username || account.profile?.uid || '(未知)'));
console.log('\n重启网关（或在管理台刷新）后生效。');
