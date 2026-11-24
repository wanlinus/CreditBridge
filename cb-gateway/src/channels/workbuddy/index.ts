// WorkBuddy 通道：一个上游（copilot.tencent.com）的协议适配器。
//
// v2 起它**不再知道「有几个账号」**：凭据由账号对象传进来（`Account.credential`），
// 通道只负责把 OpenAI 请求翻译成 WorkBuddy 的形状、把回答翻译回来。选哪个号是
// 模型 id 的事（`wb-1/hy4free`），路由层解析好了才叫到这里。
//
// 文件职责和另外三个通道一致：`auth` 凭据与请求头、`login` 交互式登录、
// `models` 模型目录、`upstream` 对话传输、`usage` 余额与签到。本文件只做声明和转发。

import type { Account, AccountProfile, AppConfig } from '../../types.ts';
import { defineChannel } from '../types.ts';
import { configureWorkBuddy, revokeWorkBuddySession, setLogger } from './auth.ts';
import { runWorkBuddyLogin } from './login.ts';
import { buildModelList, fetchWorkBuddyCatalog, setWorkBuddyModelsLogger } from './models.ts';
import { chatWorkBuddy, setWorkBuddyUpstreamLogger } from './upstream.ts';
import {
  claimCheckin,
  getWorkBuddyUsage,
  readLastCheckin,
  setWorkBuddyUsageLogger,
} from './usage.ts';

let config!: AppConfig;

// 通道自己的 id 只在这里写一次：账号的 `channelId`、账本里的 `provider` 都靠它区分。
const CHANNEL_ID = 'workbuddy';

export const workbuddyChannel = defineChannel({
  id: CHANNEL_ID,
  idPrefix: 'wb',
  label: 'WorkBuddy',

  // 客户端身份：上游拿这些串做版本门禁。
  //   clientVersion  = 桌面端 appVersion（UA 里出现两次）
  //   channelVersion = 自带的 CLI 版本（UA 里的 CLI/x）
  //   ideVersion     = X-IDE-Version 头
  // 取法（本机装了 WorkBuddy）：
  //   桌面端：`resources/install-manifest.json` 的 appVersion
  //   CLI：  `resources/app.asar.unpacked/cli/package.json` 的 version（包名 @genie/agent-cli）
  //
  // 客户端升级后改这里，**只有这一处**。版本号过期不会得到明确的错误——上游回的那句
  // 看起来像签名问题（见 `private/docs/trae-recon.md` 的同类坑）。
  identity: {
    clientVersion: '5.9.3',
    channelVersion: '2.165.0',
    ideVersion: '5.9.3',
  },

  configure({ log, config: next }) {
    config = next;
    // 版本号只注入一次（`auth.ts`），三个消费方都从那里取。
    configureWorkBuddy(workbuddyChannel.identity);
    setLogger(log);
    setWorkBuddyModelsLogger(log);
    setWorkBuddyUpstreamLogger(log);
    setWorkBuddyUsageLogger(log);
  },

  /**
   * 交互式登录：网页授权 + 轮询，由网关起后台任务、前端轮询状态，不在请求里同步等。
   *
   * 返回凭据和上游账号信息，**不写盘**——存成第几号账号是账号层的事。
   */
  async login(options) {
    return runWorkBuddyLogin({ onUrl: options?.onUrl, signal: options?.signal });
  },

  /** 凭据还能不能用：拿余额接口试一次，顺便确认 uid。 */
  async probe(account: Account): Promise<AccountProfile> {
    const credits = await getWorkBuddyUsage(account);
    return credits.account ?? {};
  },

  async modelsOf(account) {
    const models = await fetchWorkBuddyCatalog(account);
    return buildModelList(models, config.defaultContextWindow, config.defaultMaxTokens);
  },

  /**
   * 上游原始目录（保留 `lengths` / `reasoning` / `credits`），给上下文窗口编辑器用。
   * 契约里的可选部分。
   */
  async catalogOf(account) {
    return fetchWorkBuddyCatalog(account);
  },

  async creditsOf(account) {
    return getWorkBuddyUsage(account);
  },

  // WorkBuddy 没有上游签到状态接口，本地记录就是事实来源。
  async checkinStatusOf() {
    return null;
  },

  async checkinClaimOf(account) {
    return claimCheckin(account);
  },

  lastCheckinOf(account) {
    return readLastCheckin(account);
  },

  // 登出：尽力让上游把这条会话注销掉。本地删账号由账号层负责。
  async logoutOf(account) {
    await revokeWorkBuddySession(account.credential);
  },

  async chatAs(account, request) {
    return chatWorkBuddy(account, request);
  },
});
