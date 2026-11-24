// Loomy 通道：讯飞 Loomy（桌面 AI 助手）的协议适配器。
//
// 和 WorkBuddy 同构的纯 HTTP 通道——对话是标准 OpenAI 兼容 `/chat/completions`，
// session 当 Bearer。
//
// 文件职责和另外三个通道一致：`auth` 凭据与请求头、`login` 交互式登录、
// `models` 模型目录、`upstream` 对话传输、`usage` 余额。本文件只做声明和转发。
//
// 登录是短信验证码两段式交互（`onPrompt`），不是 URL 授权。多账号和 WorkBuddy /
// Trae 一样：每个号一套 session，模型 id 前半段 `lo-1` 区分。

import type { AppConfig } from '../../types.ts';
import { defineChannel } from '../types.ts';
import { LOOMY_VERSION, setLoomyLogger } from './auth.ts';
import { runLoomyLogin } from './login.ts';
import { buildModelList, loomyCatalog } from './models.ts';
import { chatLoomy, setLoomyUpstreamLogger } from './upstream.ts';
import { getLoomyCredits, setLoomyUsageLogger } from './usage.ts';

let config!: AppConfig;

// 通道自己的 id 只在这里写一次：账号的 `channelId`、账本里的 `provider` 都靠它区分。
const CHANNEL_ID = 'loomy';

export const loomyChannel = defineChannel({
  id: CHANNEL_ID,
  idPrefix: 'lo',
  label: 'Loomy',

  // 客户端身份：桌面端 package.json 的 version（`loomy-version` 头也用它）。
  identity: {
    clientVersion: LOOMY_VERSION,
  },

  configure({ log, config: next }) {
    config = next;
    setLoomyLogger(log);
    setLoomyUpstreamLogger(log);
    setLoomyUsageLogger(log);
  },

  async modelsOf(account) {
    // 没有有效 session 就不给列表（抛错时路由跳过这个账号）。
    return buildModelList(account, config.defaultContextWindow, config.defaultMaxTokens);
  },

  async catalogOf(account) {
    return loomyCatalog(account, config.defaultMaxTokens);
  },

  async creditsOf(account) {
    return getLoomyCredits(account);
  },

  /** 凭据还能不能用：读一次模型列表（最轻的对话域接口）。 */
  async probe(account) {
    const models = await buildModelList(account, config.defaultContextWindow, config.defaultMaxTokens);
    if (models.length === 0) throw new Error('Loomy 账号看不到任何模型');
    return {
      uid: account.credential?.userId || account.profile?.uid,
      username: account.profile?.username,
    };
  },

  // 交互式登录：短信验证码两段式表单。
  async login(options) {
    return runLoomyLogin({ onPrompt: options?.onPrompt, signal: options?.signal });
  },

  // Loomy 没有上游注销接口：删账号就够了，session 到期自然失效。
  // （不实现 `logoutOf`，管理台会隐藏「退出上游」按钮。）

  async chatAs(account, request) {
    return chatLoomy(account, request);
  },
});
