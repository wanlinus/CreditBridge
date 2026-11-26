// 豆包（DoubaoWork）通道：私有 HTTP + cookie 鉴权，对话是自定义 SSE。
// 它**不知道「有几个账号」**——凭据由账号对象传进来，选哪个号是模型 id 的事（`db-1/person-glm-5-4`）。
//
// 和其他四家的关键差异：**不报 token**（`reportsTokens: false`）、
// **对话有独立风控**（高频请求会要求真人验证，必须映射成 429 而不是封号）、
// **签到没有只读查询接口**（`landing/checkin` 是动作，调一次签一次）。

import type { Account, AccountProfile, AppConfig } from '../../types.ts';
import { defineChannel } from '../types.ts';
import { accountsOf } from '../../core/accounts.ts';
import { configureIdentity, fetchIdentity, setLogger, setVersionAccountSource, verifyCredential } from './auth.ts';
import { runDoubaoLogin, setLoginLogger } from './login.ts';
import { buildModelList, catalog, invalidateModelCache, setModelsLogger } from './models.ts';
import { chatDoubao, setUpstreamLogger } from './upstream.ts';
import { claimCheckin, getCredits, readLastCheckin, setUsageLogger } from './usage.ts';

let config!: AppConfig;

// 通道自己的 id 只在这里写一次：账号的 `channelId`、账本里的 `provider` 都靠它区分。
const CHANNEL_ID = 'doubao';

export const doubaoChannel = defineChannel({
  id: CHANNEL_ID,
  idPrefix: 'db',
  label: '豆包',

  /**
   * **上游不报 token**：`/chat/completion` 的 SSE 里没有任何计数字段
   * （160 个 key 全扫过）。`agent_mode` 能触发一个 `context_window_usage`，
   * 但它有时有有时没有、且 `tools` 一项就占 25K 注入的工具定义——
   * 拿它当 token 比显示 `—` 更坏，因为它看起来像真数据。
   */
  reportsTokens: false,

  /**
   * **表单式登录，不要开空白窗**。豆包走短信验证码或粘贴 cookie，上游不产生授权地址；
   * 前端若按 URL 式登录那样先开一个 `about:blank`，用户会看到一个永远白着的标签页。
   */
  loginMode: 'form',

  // 客户端身份：`SamanthaDoubaoWork/<版本>` 后缀和 `pc_version` 都用它。
  // **全项目唯一的版本值**：`auth.ts` 的 `DOUBAO_VERSION` 是空串，靠 `configure()` 注入。
  identity: {
    clientVersion: '2.38.3',
  },

  /**
   * `/version/upgrade/pull` 查最新版本（实测当前 `2.38.3` → 最新 `2.38.7`）。
   * **这条要 cookie**：不带回 `710012001 invalid gateway identity`，
   * 所以没有 ready 账号时查不到，`fetchIdentity` 会抛错、由 `channel-versions.ts` 保留旧值。
   */
  async fetchIdentity() {
    return fetchIdentity();
  },

  configure({ log, config: next }) {
    config = next;
    configureIdentity(doubaoChannel.identity.clientVersion);
    setLogger(log);
    // 漏了这句，登录步骤（device_id / 发码 / 校验 / 选号）一行日志都不出，
    // 排查 2046 时看不到用的哪个设备号——2026-11-26 才发现。
    setLoginLogger(log);
    setModelsLogger(log);
    setUpstreamLogger(log);
    setUsageLogger(log);

    // 版本查询要 cookie，所以「用哪个号去问」由这里接给 auth。
    // 优先 ready：invalid 的 cookie 查版本必然被拒。
    setVersionAccountSource(() => {
      const accounts = accountsOf(CHANNEL_ID);
      const usable = accounts.find((item) => item.status === 'ready') ?? accounts.find((item) => item.status !== 'invalid');
      return usable?.credential ?? null;
    });
  },

  async modelsOf(account) {
    return buildModelList(account, config.defaultMaxTokens);
  },

  async catalogOf(account) {
    return catalog(account, config.defaultMaxTokens);
  },

  async creditsOf(account) {
    return getCredits(account);
  },

  /**
   * 领今日签到。**幂等**：今天签过上游回 `idempotent: true`，这里映射成 `already`。
   *
   * 不实现 `checkinStatusOf`：豆包没有只读的签到查询接口
   * （`landing/checkin` 是动作，调一次签一次），面板读本地记录即可。
   */
  async checkinClaimOf(account) {
    return claimCheckin(account);
  },

  lastCheckinOf(account) {
    return readLastCheckin(account);
  },

  /**
   * 凭据还能不能用：打一次额度接口。**必须用这个**——`/alice/user/launch` 之类
   * 坏 cookie 也回 `code:0`，拿它验活会永远显示「就绪」。
   */
  async probe(account: Account): Promise<AccountProfile> {
    const failure = await verifyCredential(account.credential);
    if (failure) throw new Error(`豆包凭据不可用：${failure}`);
    const credits = await getCredits(account);
    return (credits.account as AccountProfile) ?? {};
  },

  /** 登录：短信验证码（多账号会列出来选）或导入 cookie。 */
  async login(options) {
    // **复用已有账号的设备号**：豆包账号可以设「24 小时内仅允许常用设备登录」，
    // 而「常用设备」按 device_id 认。每次登录随机生成新号就会被判成新设备（2046）。
    const existing = accountsOf(CHANNEL_ID);
    const knownDeviceId = existing
      .map((item) => item.credential?.deviceId)
      .find((id): id is string => typeof id === 'string' && id !== '');

    const result = await runDoubaoLogin({
      onPrompt: options?.onPrompt,
      signal: options?.signal,
      knownDeviceId,
    });
    invalidateModelCache();
    return result;
  },

  async chatAs(account, request) {
    return chatDoubao(account, request);
  },
});
