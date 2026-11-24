// Qoder 通道：额度/签到走 `openapi.qoder.com.cn`，对话走 HTTP SSE。
//
//   额度 / 签到  →  `/sash/*`、`/api/v1/deviceToken/*`，用 `dt-` 令牌
//   对话         →  `/algo/api/v2/service/pro/sse/agent_chat_generation`
//
// 文件职责和另外三个通道一致：`auth` 凭据续期、`login` 设备码登录、`models` 模型目录、
// `upstream` 对话传输、`usage` 余额与签到。本文件只做声明和转发。
//
// ## 对话为什么要签名
//
// 对话请求体是**加密**的，并带一组 `cosy-*` 头（含 `cosy-key`、COSY 令牌）。
// 这套签名的实现是一块 313KB 的 wasm（`qoder_auth_wasm`），内嵌在官方 CLI 里。
// 见 `cosy/`——已抽出来独立运行，不再需要 CLI。

import type { AppConfig } from '../../types.ts';
import { defineChannel } from '../types.ts';
import { accountsOf } from '../../core/accounts.ts';
import { deviceFlowLogin, QODER_CLI_VERSION } from './login.ts';
import { buildModelList, getModelNames, invalidateModelCache, qoderCatalog, setModelsLogger } from './models.ts';
import { chatQoder, setQoderModelSource, setQoderUpstreamLogger } from './upstream.ts';
import {
  claimCheckin,
  getCheckinStatus,
  getQoderCredits,
  readLastCheckin,
  setQoderUsageLogger,
} from './usage.ts';

let config!: AppConfig;

// 通道自己的 id 只在这里写一次：账号的 `channelId`、账本里的 `provider` 靠它区分。
const CHANNEL_ID = 'qoder';

/** 共享日志句柄。`configure()` 之前是 null，只影响启动极早期的日志。 */
let channelLog: ((...args: unknown[]) => void) | null = null;

function logStatus(message: string): void {
  if (channelLog) channelLog(`[qoder] ${message}`);
}

export const qoderChannel = defineChannel({
  id: CHANNEL_ID,
  idPrefix: 'qd',
  label: 'Qoder',

  /**
   * **可以挂多个号**：每个号有独立凭据、独立签名，不存在串号问题。
   *
   * （曾经限制为 false，理由是对话依赖常驻 CLI 的登录态——那是机器级的一份，多挂号
   * 会让 `qd-2` 实际花 `qd-1` 的钱。那个前提随 CLI 一起消失了。）
   */
  multiAccount: true,

  /** **报 token 用量**：上游 SSE 最后一帧自带完整 usage。 */
  reportsTokens: true,

  // 报给上游的客户端版本（`login.ts` 的 `QODER_CLI_VERSION`，
  // `cosy-version` 请求头用同一个值）。放这里是为了让 `/health` 一眼看出
  // 「报的是哪一版」，排查时少一次进容器翻文件。
  identity: {
    clientVersion: QODER_CLI_VERSION,
  },

  configure({ log, config: next }) {
    config = next;
    channelLog = log;
    setModelsLogger(log);
    setQoderUpstreamLogger(log);
    setQoderUsageLogger(log);

    // 模型名单要 COSY 签名才能取，而签名要账号——所以取数动作由 `upstream`
    // 提供，这里把「从哪儿拿账号」接进去。依赖方向 `upstream → models`，不成环。
    //
    // 优先挑 `ready` 的号：`invalid` 的令牌已废，拿它去签名必然失败。
    setQoderModelSource(async () => {
      const accounts = accountsOf(qoderChannel.id);
      return accounts.find((a) => a.status === 'ready') ?? accounts.find((a) => a.status !== 'invalid') ?? null;
    });
  },

  async modelsOf() {
    // 名单实时取（HTTP 接口 + 本地缓存），不写死：模型会随产品迭代增删。
    // 有缓存立刻返回，过期时后台刷新，不挡面板。
    //
    // 模型名单和具体账号无关（同一个上游），所以这里不看 account。
    const names = await getModelNames();
    return buildModelList(names, config.defaultContextWindow, config.defaultMaxTokens);
  },

  /**
   * 上游上下文档位（`context_config`：200K / 400K / 1M）。
   *
   * 快照里带了就照抄，没带就按上限比例推三档——但**必须有个下拉**：Qoder 的
   * `max_input_tokens` 只是默认档，只显示一个数字会让人以为窗口只能那么大。
   */
  async catalogOf() {
    return qoderCatalog(config.defaultMaxTokens);
  },

  async creditsOf(account) {
    return getQoderCredits(account);
  },

  // Qoder 有真实的状态接口（`/sash/api/v1/me/campaigns`），不是 null。
  async checkinStatusOf(account) {
    return getCheckinStatus(account);
  },

  async checkinClaimOf(account) {
    return claimCheckin(account);
  },

  lastCheckinOf(account) {
    return readLastCheckin(account);
  },

  /**
   * 就绪检查：读一次额度就够（它会用 `dt-` 打 `/sash/*`）。
   *
   * 额外提一句「凭据里缺签名信息」：那只影响对话（会现场补算），
   * 不该让它挡住账号就绪——额度和签到才是面板的主要信息。
   */
  async probe(account) {
    const credits = await getQoderCredits(account);
    const credential = account.credential as { userInfo?: { key?: string } } | null | undefined;
    if (!credential?.userInfo?.key) {
      logStatus('凭据里缺少对话签名信息（老数据或登录时现算失败）；对话会现场补算，额度与签到不受影响');
    }
    return credits.account ?? {};
  },

  /**
   * 登录：**一次设备码授权搞定全部**。
   *
   * 早期要授权两次（设备流拿 `dt-`，再 `qoderclicn login` 拿对话态）。
   * 现在对话签名用的 `encrypt_user_info` / `key` 由 wasm 从 `dt-` 现算
   * （见 `cosy/deriveRuntimeFields`），所以一次就够，`onUrl` 只回调一次。
   */
  async login(options) {
    const result = await deviceFlowLogin(options);
    // 换账号后模型名单可能不一样，缓存作废。
    invalidateModelCache();
    return result;
  },

  async chatAs(account, request) {
    // `idPrefix` 从通道对象传下去，不在 upstream 里写死 `'qd'`——元数据只有一份，
    // 而聊天路径要它去查「用户在 /models 页给这个模型配了多大的窗口」。
    return chatQoder(account, request, qoderChannel.idPrefix);
  },
});
