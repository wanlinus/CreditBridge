// Loomy 通道：讯飞 Loomy（桌面 AI 助手）的协议适配器。纯 HTTP，对话是标准 OpenAI 兼容
// `/chat/completions`、session 当 Bearer；登录是短信验证码两段式交互（`onPrompt`），不是 URL 授权。
// 多账号每个号一套 session，模型 id 前半段 `lo-1` 区分。

import type { AppConfig } from '../../types.ts';
import { defineChannel } from '../types.ts';
import { configureIdentity, fetchIdentity, setLogger } from './auth.ts';
import { runLoomyLogin } from './login.ts';
import { buildModelList, catalog } from './models.ts';
import { chatLoomy, setUpstreamLogger } from './upstream.ts';
import { getCredits, setUsageLogger } from './usage.ts';

let config!: AppConfig;

// 通道自己的 id 只在这里写一次：账号的 `channelId`、账本里的 `provider` 都靠它区分。
const CHANNEL_ID = 'loomy';

export const loomyChannel = defineChannel({
  id: CHANNEL_ID,
  idPrefix: 'lo',
  label: 'Loomy',

  /** 短信验证码表单登录，上游不产生授权地址——不要开空白窗。 */
  loginMode: 'form',

  // 客户端身份：桌面端 package.json 的 version（`loomy-version` 头也用它）。
  // **全项目唯一的版本值**：`auth.ts` 的 `LOOMY_VERSION` 是空串，靠 `configure()` 注入。
  identity: {
    clientVersion: '0.9.39',
  },

  /** 桌面端走标准 electron-updater，`latest.yml` 里有 `version:`。 */
  async fetchIdentity() {
    return { clientVersion: await fetchIdentity() };
  },

  configure({ log, config: next }) {
    config = next;
    configureIdentity(loomyChannel.identity.clientVersion);
    setLogger(log);
    setUpstreamLogger(log);
    setUsageLogger(log);
  },

  async modelsOf(account) {
    // 没有有效 session 就不给列表（抛错时路由跳过这个账号）。
    return buildModelList(account, config.defaultContextWindow, config.defaultMaxTokens);
  },

  async catalogOf(account) {
    return catalog(account, config.defaultMaxTokens);
  },

  async creditsOf(account) {
    return getCredits(account);
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

  async login(options) {
    return runLoomyLogin({ onPrompt: options?.onPrompt, signal: options?.signal });
  },

  async chatAs(account, request) {
    return chatLoomy(account, request);
  },
});
