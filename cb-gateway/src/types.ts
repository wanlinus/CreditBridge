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
 * 从上游拉到的版本号。可以包含 `identity` 的任意字段。
 *
 * **`clientVersion` 也允许更新**：2026-11-25 实测 Qoder 换成桌面端版本后
 * 签到 / 模型列表 / 对话三项全通，说明上游不把它当精确门禁。
 * 但通道实现要自己判断该改哪些——不确定的字段别返回，返回了就会覆盖。
 */
export type IdentityPatch = Partial<ChannelIdentity>;


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

/**
 * `invalid` 凭据坏了，`disabled` 用户停用；两种模型 id 仍在列表里，请求时才报错。
 *
 * **没有 `cooldown`**：上游 429 只回给客户端、不改账号状态（限流是按模型的，
 * 恢复时间网关猜不准——2026-11-13 删掉了猜 5 分钟那套）。原先那一档从来没有生产者。
 */
export type AccountStatus = 'ready' | 'invalid' | 'disabled';

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

/**
 * 登录形态。决定前端要不要在点击时先开一个空白窗。
 *
 * - `url`：授权页式（WorkBuddy / Trae / Qoder）。网关会把授权地址交出来，
 *   浏览器得**在点击的同一轮事件里**先开好窗，否则弹窗拦截会静默失败。
 * - `form`：表单式（Loomy 短信 / 豆包短信或 cookie）。不产生授权地址，
 *   **不该开窗**——开了就是一个永远停在 `about:blank` 的空白标签页。
 *
 * 默认 `url`：只有明确声明 `form` 的通道才不开窗，这样老通道行为不变。
 */
export type LoginMode = 'url' | 'form';

/** 一个可选项。有 `options` 的 prompt 前端渲染成按钮，而不是输入框。 */
export interface LoginPromptOption {
  /** 回填给通道的值（`onPrompt` 收到的那个字符串）。 */
  value: string;
  label: string;
  /** 悬停提示，说清这个选项的适用条件。 */
  hint?: string;
  /** 头像 URL（账号选择用）。有它就渲染成带头像的卡片。 */
  avatar?: string;
  /** 第二行副标题（比如租户名「飞书个人版」）。 */
  subtitle?: string;
  /**
   * 这一项选不了，界面上灰掉。**仍然显示**——用户得知道上游给了哪些选项，
   * 不然会以为网关漏了。典型：豆包 2046 的 `oauth_douyin_verify`（要跳抖音授权）。
   */
  disabled?: boolean;
}

export interface LoginPrompt {
  /** 一次登录可能有多个 prompt（手机号 → 验证码），靠它区分，前端据此重建输入框。 */
  id: string;
  label: string;
  placeholder?: string;
  inputType?: 'text' | 'number' | 'password';
  submitLabel?: string;
  /**
   * 预设选项。**有它时前端渲染按钮让用户点选**，不要求用户打字。
   * 典型场景：豆包登录要选「短信验证码 / 导入 cookie」——让用户输 `1` 或 `2` 是反人类的。
   */
  options?: LoginPromptOption[];
  /**
   * 要用户完成一次验证（图形验证码）。**有它时前端嵌 iframe 显示验证页**，
   * 用户做完点「已完成」回填 `'done'`。
   *
   * 数据来自上游响应的 `verify_center_decision_conf`（豆包 1105 风控）。
   */
  challenge?: LoginPromptChallenge;
  /**
   * 二维码图片（data URI）。**有它时前端渲染成图片**，用户用已登录的 App 扫。
   * 典型场景：豆包 2046 的 `qr_code_verify`——上游给 base64，网关不用存文件。
   */
  qrCode?: string;
  /**
   * 要用户填一位数验证码（OTP）。**有它时前端渲染大格子输入框**。
   *
   * 和普通的 `inputType: 'number'` 不同：OTP 是「从别处看一位数字回来填」，
   * 视觉上要显眼，而且长度固定。目前只有豆包 2046 的 `push_verify` 用它。
   */
  otpLength?: number;
  /**
   * 短信验证要的三段信息。**结构化传下去，别塞进 `label` 里**——
   * 号码、正文、被验证手机号挤成一句话，用户复制时很容易抄错。
   */
  sms?: LoginPromptSms;
}

/** 短信验证（豆包 2046 的 `mobile_up_sms_verify`）要显示的东西。 */
export interface LoginPromptSms {
  /** 要发到的号码，如 `10691859839103`。 */
  channelMobile: string;
  /** 短信正文，如 `YZ`。 */
  content: string;
  /** 被验证的手机号（脱敏），如 `155******33`。可能为空。 */
  mobile: string;
}

/** 让用户做一次验证时交给前端的材料。 */
export interface LoginPromptChallenge {
  /** 验证页地址，直接嵌 iframe。 */
  url: string;
  /** 挑战码（`decision_conf.detail`），作为 `challenge_code` 传给验证页。 */
  code: string;
  /** 验证类型：slide / 3d / text / icon / whirl / semantic_reasoning。 */
  subtype: string;
  /** 验证票据。 */
  ticket: string;
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

  /**
   * 登录形态，默认 `url`。设成 `form` 时前端**不会**在点击「添加」时开空白窗——
   * 表单式登录（短信验证码 / 粘贴 cookie）不产生授权地址，开了就是空白标签页。
   */
  loginMode?: LoginMode;

  /** 上游会不会在响应里报 token 用量，默认 `true`。`false` 时账本恒为 0，界面要显示 `—`——0 会被读成「用过但没消耗」。 */
  reportsTokens?: boolean;

  /** 报给上游的客户端身份（版本号串）。必填：写死会烂，见 `ChannelIdentity`。 */
  identity: ChannelIdentity;

  /**
   * 去上游查最新版本号，返回要覆盖的字段（见 `IdentityPatch`）。
   *
   * 上游升级后不让老客户端请求时，靠它把版本号跟上，不用改代码重新部署。
   * 不实现就是「这个通道没有可查的更新源」，一直用 `identity` 里的写死值。
   * **返回什么就覆盖什么**：拿不准的字段不要返回。
   * **失败必须抛错**：路由会保留旧值并在 `/api/health` 标 `versionSource: 'cached'`，
   * 静默返回空对象会让「查失败」和「上游没给版本」分不清。
   */
  fetchIdentity?(): Promise<IdentityPatch>;

  configure?(ctx: ChannelContext): void;

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

  /** 转发一次对话补全。失败抛 `UpstreamError` 带上游状态码：401 → 路由标 `invalid`，其余不动（429 原样回给客户端）。 */
  chatAs(account: Account, request: ChatRequest): Promise<ChatOutcome>;
}
