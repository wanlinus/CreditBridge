// 跨模块共享的领域类型：凭据、HTTP 层要序列化的目录与通道回答、通道契约本身。
// 2026-11-22 曾按领域拆成 `types/` 下 7 个文件又合回来——文件长是因为注释，不是逻辑复杂。

export interface AppConfig {
  host: string;
  port: number;
  defaultContextWindow: number;
  defaultMaxTokens: number;
  verbose: boolean;
  /** 每天定时签到的时间点，`HH:MM` 本地时间。 */
  checkinTime: string;
}

/** 通道自述的客户端身份，报给上游的版本号串。必填：上游拿它当门禁，写死会烂，漏了类型检查就报错。 */
export interface ChannelIdentity {
  clientVersion: string;
  channelVersion?: string;
  ideVersion?: string;
  /** Trae 账号接口的 `x-app-version`。**和上面几个不是同一个字段**，混用会静默失效。 */
  appVersion?: string;
}

/**
 * 从上游拉到的版本号。只覆盖该通道**允许自动更新**的字段：
 * 换令牌的门禁字段（`clientVersion`）不自动改，自动改可能触发上游校验。
 */
export type IdentityPatch = Partial<Pick<ChannelIdentity, 'channelVersion' | 'ideVersion' | 'appVersion'>>;


export interface TraeCredential {
  token: string;
  refreshToken: string;
  userId: string;
  username: string;
  refreshBase: string;
  expiresAt: number;
  refreshExpiresAt: number;
  machineId: string;
  checkinDeviceId: string;
  /** 本机自造的稳定设备号，`checkinDeviceId` 缺失时用它。**必须持久化**：服务端按设备号记当天签没签，换号会让它永远是 false。 */
  selfDeviceId?: string;
  /** 登录时生成的 EC P-256 密钥对。**必须跟着凭据走**：刷新签名要用登录时那把私钥，换一对必然验签失败。 */
  privateKeyPEM?: string;
  publicKeyPEM?: string;
  source: string;
}

/** `/v1/models` 里的一项。 */
export interface ModelInfo {
  id: string;
  object: string;
  name: string;
  context_length: number;
  max_output_tokens: number;
  /** `context_length` 是网关默认值而非上游报的——「上游只有 20 万」和「不知道，按默认给」是两种结论。 */
  contextLengthEstimated?: boolean;
  reasoning?: boolean;
  /** 上游实际支持的档位名，按上游给的顺序。**照抄这个数组**，自己补标准四档会让请求静默按默认档跑。 */
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  input?: string[];
}

export interface CatalogModel {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  lengths?: { default?: number; options: number[] };
  supportsImages: boolean;
  supportsReasoning: boolean;
  reasoning?: unknown;
}

/** `cooldown` 是临时的（上游限流，到点回 `ready`），`invalid` 凭据坏了，`disabled` 用户停用；后两种模型 id 仍在列表里，请求时才报错。 */
export type AccountStatus = 'ready' | 'cooldown' | 'invalid' | 'disabled';

export interface AccountProfile {
  uid?: string;
  username?: string;
  domain?: string;
}

export interface Account {
  /** `<idPrefix>-<seq>`（`wb-1`），生成后永不改，账本和模型 id 都引用它。 */
  id: string;
  channelId: string;
  seq: number;
  /** 显示名，可改。**不进模型显示名**——那用的是账号 id，改 label 只影响管理台称呼。 */
  label: string;
  credential: any;
  status: AccountStatus;
  cooldownUntil: number | null;
  statusMessage: string | null;
  profile: AccountProfile;
  /** 要不要自动签到，默认 `true`。和 `status: 'disabled'` 不是一回事：那个连对话也不走。 */
  checkinEnabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AccountInfo {
  uid?: string;
  username?: string;
  domain?: string;
  tokenExpiresAt?: string | null;
  source?: string;
}

/** 面板「积分包」表的一行。三家上游字段名各不相同，归一化责任在通道——曾直接透传，整表渲染成 `undefined` 而类型检查看不到。 */
export interface UsagePackage {
  name: string;
  /** **可以是 `null`**：Loomy 每日重置、没有「总额度」概念。硬凑成 `剩余 + 已用` 会得到一个看着自洽、实际错误的数字。 */
  limit: number | null;
  used: number;
  expireAt: number | null;
}

export interface Credits {
  provider: string;
  supported: boolean;
  totalRemain: number;
  packages?: UsagePackage[];
  account?: AccountInfo;
  [key: string]: unknown;
}

/** **`disabled` 和 `pending` 必须分开**：前者今天不用再试，后者过会儿再来，记成 `already` 会一片正常却一次没领到；`skipped` 是网关开关的决定，只进 `checkin_log`。 */
export type CheckinStatusKind = 'checked' | 'already' | 'disabled' | 'pending' | 'error' | 'skipped';

export interface CheckinRecord {
  date: string;
  status: CheckinStatusKind;
  credits?: number | null;
  extraCredits?: number;
  streakDays?: number | null;
  message?: string;
  at?: number;
  code?: number;
  outcome?: string;
  /** 通道自述「这次失败值得等一会儿再试」。只出现在 `checkinClaimOf` 的返回值上，不进 `checkin_state`。 */
  transient?: boolean;
  /** 上游业务码（Trae 的 9074 / 9004）。同上，只在返回值上。 */
  upstreamCode?: number;
}

export interface CheckinStatus {
  enable: boolean;
  checkedIn: boolean;
  credits: number;
  extraCredits: number;
  didCheckedIn?: boolean;
}

export type ChatUsage = Record<string, unknown> & {
  credit?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

/** 一次对话请求。`body.model` 已经是上游认的裸 id（账号段和前缀都剥掉了）。 */
export interface ChatRequest {
  body: Record<string, any>;
  /** 客户端断开时触发。通道**必须**把它传给上游 fetch——否则用户关掉对话后网关还在读没人收的流，白烧额度且不报错。 */
  signal?: AbortSignal;
  /** 拿到上游用量时调一次（流式在最后一个 chunk 之后）。用回调而不是让通道记账：`provider` / `account` 由路由层解析。 */
  onUsage?: (usage: ChatUsage | null) => void;
}

export type ChatOutcome =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'stream'; status: number; headers: Record<string, string>; body: AsyncIterable<string> };

export interface ChannelContext {
  log: (...args: unknown[]) => void;
  config: AppConfig;
}

export interface LoginPrompt {
  /** 一次登录可能有多个 prompt（手机号 → 验证码），靠它区分，前端据此重建输入框。 */
  id: string;
  label: string;
  placeholder?: string;
  inputType?: 'text' | 'number' | 'password';
  submitLabel?: string;
}

export interface LoginResult {
  credential: any;
  profile?: AccountProfile;
  label?: string;
}

/** 一个上游代理，对外表现为 OpenAI 兼容接口。加通道 = 实现这个接口 + 在 `channels/index.ts` 登记一行，不用改路由。 */
export interface Channel {
  /** 账本里的 `provider`、账号的 `channelId`、`channelById()` 的键，三处同一个值。 */
  id: string;

  /** 模型 id 的短前缀（`wb` → `wb-1/hy4free`）。必须全局唯一且不含 `/`、`-`：撞前缀会让一批请求静默走错上游。 */
  idPrefix: string;

  label: string;

  /** 能不能挂多个账号，默认 `true`。设成 `false` 时账号层会拦住第二个号。 */
  multiAccount?: boolean;

  /** 上游会不会在响应里报 token 用量，默认 `true`。`false` 时账本恒为 0，界面要显示 `—`——0 会被读成「用过但没消耗」。 */
  reportsTokens?: boolean;

  /** 报给上游的客户端身份（版本号串）。必填：写死会烂，见 `ChannelIdentity`。 */
  identity: ChannelIdentity;

  /**
   * 去上游查最新版本号，返回**允许自动更新**的那几个字段（见 `IdentityPatch`）。
   *
   * 上游升级后不让老客户端请求时，靠它把版本号跟上，不用改代码重新部署。
   * 不实现就是「这个通道没有可查的更新源」，一直用 `identity` 里的写死值。
   * **失败必须抛错**：路由会保留旧值并在 `/api/health` 标 `versionSource: 'cached'`，
   * 静默返回空对象会让「查失败」和「上游没给版本」分不清。
   */
  fetchIdentity?(): Promise<IdentityPatch>;

  configure?(ctx: ChannelContext): void;

  /** 账号就绪后调一次（启动预热）。**不要在这里打上游账务接口**：那种「启动时悄悄失败」没人会看。 */
  warmup?(account: Account): Promise<void>;

  /** 交互式登录，会阻塞几分钟，网关把它包成「后台任务 + 前端轮询」。`signal` 触发时要**立刻**关回调服务器，否则旧任务占着端口空转到超时。 */
  login?(options?: {
    onUrl?: (url: string) => void;
    onPrompt?: (prompt: LoginPrompt) => Promise<string>;
    signal?: AbortSignal;
  }): Promise<LoginResult>;

  /** 登录回调是否必须从浏览器那台机器的环回地址打进来。**端口随机（`0`）时必须返回 `null`**：外部预告不了随机端口。 */
  loginLoopback?(): { port: number; path: string } | null;

  probe?(account: Account): Promise<AccountProfile>;

  /** 某个账号看得到的模型目录。按账号取而不是按通道缓存：不同号的套餐不同，目录可能不一样。 */
  modelsOf(account: Account): Promise<ModelInfo[]>;

  catalogOf?(account: Account): Promise<CatalogModel[]>;

  /** 余额快照。`totalRemain` 是徽标和面板唯一读的数字。失败请抛错：路由包成 `{supported:false, error}` 仍以 200 返回。 */
  creditsOf(account: Account): Promise<Credits>;

  checkinStatusOf?(account: Account): Promise<CheckinStatus | null>;

  /** 领取今日签到。幂等由通道保证：领过返回 `status === 'already'` 而不是报错，只有真失败才返回 `'error'`。 */
  checkinClaimOf?(account: Account): Promise<CheckinRecord>;

  /** 读本地签到记录。**同步、不发网络请求。** */
  lastCheckinOf?(account: Account): CheckinRecord | null;

  /** 给这个账号换一套设备身份，返回要写回凭据的新值（不落盘）。有些上游签到按**设备**记，多号共用设备号会互相干扰（Trae 的 9074）。 */
  rotateDeviceIdOf?(account: Account): Record<string, any> | null;

  /** 让上游注销这条会话。**只管上游、不碰本地账号**——删凭据从来不等于登出。 */
  logoutOf?(account: Account): Promise<void>;

  /** 转发一次对话补全。失败抛 `UpstreamError` 带上游状态码：401 → 路由标 `invalid`，429 → 标 `cooldown`。 */
  chatAs(account: Account, request: ChatRequest): Promise<ChatOutcome>;
}
