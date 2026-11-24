// 跨模块共享的领域类型。
//
// 这里只描述「跨边界流动」的数据：凭据、HTTP 层要序列化的目录与通道回答、通道契约本身。
// 模块内部的东西交给类型推断即可。
//
// 2026-11-22 曾按领域拆成 `types/` 下 7 个文件，随后又合回来：拆完之后 5 个文件的实际
// 代码不到 30 行，读一个类型要先判断它在哪个文件里，比一个文件翻着看更慢。**文件长是
// 因为注释，不是因为逻辑复杂**——该精简的是注释，不是拆文件。

// ---------------------------------------------------------------- 配置

export interface AppConfig {
  host: string;
  port: number;
  defaultContextWindow: number;
  defaultMaxTokens: number;
  verbose: boolean;
}

/**
 * 通道自述的客户端身份——报给上游的版本号串。
 *
 * 放在通道接口上而不是全局配置：各家值完全不同，放进公共结构就变成「一个通道的专属
 * 字段躺在配置里」，另一个通道只能自己写死。上游拿版本号当门禁，而报错文案会骗人
 * （Trae 版本串写死在 3.4.15 时回的是 `401 Device proof required`，看起来像签名问题）。
 * 所以它是必填项：漏了类型检查就报错。
 */
export interface ChannelIdentity {
  /** 主版本号：WorkBuddy = appVersion，Trae = product.json 的 version。 */
  clientVersion: string;
  /** 附加渠道串：WorkBuddy 的 CLI 版本、Trae 的 tronBuildVersion。 */
  channelVersion?: string;
  /** WorkBuddy 单独要的 IDE 版本（`X-IDE-Version` 头）。 */
  ideVersion?: string;
  /**
   * Trae 账号接口的 `x-app-version`。**和上面两个不是同一个字段**——product.json 里
   * version / tronBuildVersion / appVersion 三者并列，混用会静默失效。
   */
  appVersion?: string;
}

// ---------------------------------------------------------------- 凭据

/** Trae 凭据（从 storage.json 的 `tc` 信封解密得到）。 */
export interface TraeCredential {
  token: string;
  refreshToken: string;
  userId: string;
  username: string;
  refreshBase: string;
  expiresAt: number;
  refreshExpiresAt: number;
  machineId: string;
  /** 客户端注册过的 aha 设备号。没装过客户端的机器上拿不到，由 `selfDeviceId` 顶替。 */
  checkinDeviceId: string;
  /**
   * 本机自造的稳定设备号，`checkinDeviceId` 缺失时用它。
   *
   * 可以自造：客户端本身就是 `deviceId !== "0" ? deviceId : localDeviceId`，实测账号
   * 接口对任意非空 `x-device-id` 都放行，只有空串回 9004。
   *
   * **必须持久化**：服务端按设备号记「这台设备今天签没签」，每次换号会让它永远是 false。
   */
  selfDeviceId?: string;
  /**
   * 登录时生成的 EC P-256 密钥对。**必须跟着凭据走**：刷新签名要用登录时那把私钥，
   * 公钥要原样回填 `DeviceInfo.DevicePublicKey`，换一对必然验签失败。
   */
  privateKeyPEM?: string;
  publicKeyPEM?: string;
  source: string;
}

// ---------------------------------------------------------------- 模型

/** `/v1/models` 里的一项。 */
export interface ModelInfo {
  id: string;
  object: string;
  name: string;
  context_length: number;
  max_output_tokens: number;
  /**
   * `context_length` 是网关的默认值，不是上游报的。
   *
   * 要单独标出来：`200000` 可能是「上游确实只有 20 万」，也可能是「不知道，按默认给
   * 一个」——两种结论对用户的行动建议完全不同，界面据此决定文案。
   */
  contextLengthEstimated?: boolean;
  /** 模型支不支持思考档位。非 OpenAI 标准字段，多出来的不影响客户端解析。 */
  reasoning?: boolean;
  /**
   * 上游实际支持的档位名，按上游给的顺序。
   *
   * 同步 profile 时**照抄这个数组**，不要自己补一套标准四档：补了就会出现「选了个
   * 上游不认的档」，那种请求不报错，只会静默按默认档跑。缺省表示沿用客户端默认表。
   */
  reasoningEfforts?: string[];
  /** 上游默认档位。缺省表示不知道。 */
  defaultReasoningEffort?: string;
  /** 支持的输入模态，用于生成 profile 里的 `input`。 */
  input?: string[];
}

/** 上游原始目录项（WorkBuddy 的 `/v3/config`）。 */
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

// ---------------------------------------------------------------- 账号

/**
 * `cooldown` 是临时的（上游限流，到点自动回 `ready`），`invalid` 是凭据坏了，
 * `disabled` 是用户主动停用。后两种不影响账号 id 存在——模型 id 还在列表里，
 * 请求时才报明确错误，比「模型凭空消失」好查。
 */
export type AccountStatus = 'ready' | 'cooldown' | 'invalid' | 'disabled';

export interface AccountProfile {
  uid?: string;
  username?: string;
  domain?: string;
}

/**
 * 上游账号 = 通道的一个实例。一个通道可以挂多个号，各有自己的额度和登录态——
 * 这也是「模型 id 里带账号」的原因。
 *
 * 落库在 `account` 表；`credential` / `profile` 存 JSON 文本，因为四个通道的字段
 * 完全不同，拆成列等于「加一个通道就要改表」。
 */
export interface Account {
  /** `<idPrefix>-<seq>`（`wb-1`），生成后永不改，账本和模型 id 都引用它。 */
  id: string;
  channelId: string;
  seq: number;
  /** 显示名，可改。**不进模型显示名**——那用的是账号 id，改 label 只影响管理台称呼。 */
  label: string;
  /** 形状由通道自己定义。 */
  credential: any;
  status: AccountStatus;
  cooldownUntil: number | null;
  statusMessage: string | null;
  profile: AccountProfile;
  /**
   * 要不要自动签到。默认 `true`。
   *
   * 和 `status: 'disabled'` 不是一回事：那个是整个号不用了（对话也不走），这个只管签到。
   */
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

// ---------------------------------------------------------------- 额度与签到

/**
 * 面板「积分包」表的一行。
 *
 * 三家上游字段名各不相同（Trae `{name,limit,used}`、WorkBuddy `{packageName,size,remain}`、
 * Qoder `{packageName,size,remain,used}`），归一化的责任在通道。曾经直接透传，界面
 * 按 Trae 那套读，于是整张表渲染成 `undefined / — / 0`，而 type 检查看不到。
 */
export interface UsagePackage {
  name: string;
  /**
   * **可以是 `null`**：有些通道没有「总额度」这个概念（Loomy 每日重置、不用作废）。
   * 硬凑成 `剩余 + 已用` 会得到一个看着自洽、实际错误的数字。
   */
  limit: number | null;
  used: number;
  /** 没有到期概念就是 null。 */
  expireAt: number | null;
}

/** `creditsOf()` 的响应体，也是 `/api/accounts/<id>/credits` 的主体。 */
export interface Credits {
  provider: string;
  supported: boolean;
  totalRemain: number;
  packages?: UsagePackage[];
  account?: AccountInfo;
  [key: string]: unknown;
}

/**
 * 一次签到的结果。
 *
 * **`disabled` 和 `pending` 必须分开**：前者是「今天不用再试了」（上游永久不开放），
 * 后者是「过会儿再来」（活动窗口还没开）。把 `pending` 记成 `already` 看起来像已签，
 * 实际一次都没领到，而面板上一片正常。
 *
 * **`skipped` 是网关自己的决定，不是上游的回应**：两级开关把它关掉了，压根没打上游。
 * 它只出现在 `checkin_log`（留痕用），不进 `checkin_state`——状态是「今天的结论」，
 * 而「被开关跳过」不是一个需要幂等的结论，明天开关一开照样要签。
 */
export type CheckinStatusKind = 'checked' | 'already' | 'disabled' | 'pending' | 'error' | 'skipped';

/** 一次签到尝试，落在 `checkin_state` 表。 */
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
  /**
   * 通道自述「这次失败值得等一会儿再试」。只出现在 `checkinClaimOf` 的**返回值**上，
   * 不进 `checkin_state`——它是给调度器选重试档位用的瞬时信息，不是签到历史。
   */
  transient?: boolean;
  /** 上游业务码（Trae 的 9074 / 9004）。同上，只在返回值上。 */
  upstreamCode?: number;
}

/** 上游真实的签到状态；上游没有状态接口时为 `null`。 */
export interface CheckinStatus {
  enable: boolean;
  checkedIn: boolean;
  credits: number;
  extraCredits: number;
  didCheckedIn?: boolean;
}

// ---------------------------------------------------------------- 对话

export type ChatUsage = Record<string, unknown> & {
  credit?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

/** 一次对话请求。`body.model` 已经是上游认的裸 id（账号段和前缀都剥掉了）。 */
export interface ChatRequest {
  body: Record<string, any>;
  /**
   * 客户端断开时触发。通道**必须**把它传给上游 fetch——否则用户关掉对话后网关还在
   * 读一个没人收的流，白烧上游额度，而且不报任何错。
   */
  signal?: AbortSignal;
  /**
   * 拿到上游用量时调一次。流式是最后一个 chunk 之后，非流式是拿到 JSON 时。
   *
   * 用回调而不是让通道自己记账：账本要记 `provider` 和 `account`，它们由路由层解析
   * 出来，让每个通道各拼一遍等于把同一件事写三份。
   */
  onUsage?: (usage: ChatUsage | null) => void;
}

/**
 * 通道的转发结果。形态由通道决定（它看上游的 content-type），路由层只负责按形态发。
 *
 * 为什么不是「通道自己写 res」：那样通道就绑死了 HTTP，没法脱离 req/res 单独测。
 */
export type ChatOutcome =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'stream'; status: number; headers: Record<string, string>; body: AsyncIterable<string> };

// ---------------------------------------------------------------- 通道

/** `configure()` 收到的装配上下文，由 `src/index.ts` 启动时构造。 */
export interface ChannelContext {
  log: (...args: unknown[]) => void;
  config: AppConfig;
}

/** 登录过程中「向用户要输入」的一步（短信验证码这类非 URL 流程）。 */
export interface LoginPrompt {
  /** 一次登录可能有多个 prompt（手机号 → 验证码），靠它区分，前端据此重建输入框。 */
  id: string;
  label: string;
  placeholder?: string;
  inputType?: 'text' | 'number' | 'password';
  submitLabel?: string;
}

/** 一次登录换到的东西。落盘交给账号层，通道不碰磁盘。 */
export interface LoginResult {
  credential: any;
  profile?: AccountProfile;
  /** 上游昵称，作为账号默认 label。拿不到就不填。 */
  label?: string;
}

/**
 * 一个上游代理，对外表现为 OpenAI 兼容接口。
 *
 * 加通道 = 实现这个接口 + 在 `channels/index.ts` 登记一行，不用改路由。
 * 凭据由 `account` 传进来——通道不知道「自己挂了几个号」，也就没有选号逻辑。
 *
 * 错误约定：`creditsOf` / `modelsOf` / `probe` 失败直接抛错；`chatAs` 抛
 * `UpstreamError`（带状态码，路由据此改账号状态）；`checkinStatusOf` 在「上游没有
 * 这个接口」时返回 `null` 而不是抛错。
 */
export interface Channel {
  /** 账本里的 `provider`、账号的 `channelId`、`channelById()` 的键，三处同一个值。 */
  id: string;

  /**
   * 模型 id 的短前缀（`wb` → `wb-1/hy4free`）。
   *
   * 必须全局唯一且不含 `/`、`-`：撞前缀会让一批请求静默走错上游，而 `-` 是前缀和
   * 序号的分隔符。注册表加载时校验。
   */
  idPrefix: string;

  label: string;

  /** 能不能挂多个账号，默认 `true`。设成 `false` 时账号层会拦住第二个号。 */
  multiAccount?: boolean;

  /**
   * 上游会不会在响应里报 token 用量，默认 `true`。
   *
   * `false` 时该通道在账本里恒为 0，界面要显示 `—` 并说明「该通道不提供」——0 会被
   * 读成「用过但没消耗」，那是两回事。
   */
  reportsTokens?: boolean;

  /** 报给上游的客户端身份（版本号串）。必填：写死会烂，见 `ChannelIdentity`。 */
  identity: ChannelIdentity;

  /** 启动时调用一次，早于 `listen`。用来接日志、传版本号。 */
  configure?(ctx: ChannelContext): void;

  /**
   * 账号就绪后调一次（启动预热）。
   *
   * **不要在这里打上游账务接口**：失败只记日志，那种「启动时悄悄失败」没人会看。
   */
  warmup?(account: Account): Promise<void>;

  /**
   * 交互式登录。会阻塞几分钟，所以网关把它包成「后台任务 + 前端轮询」。
   *
   * 两种形态由通道自述：URL 授权用 `onUrl`，表单输入用 `onPrompt`（两者都实现时
   * 表单优先）。`signal` 触发时要**立刻**关掉回调服务器并让 promise 拒绝，否则旧任务
   * 会占着端口空转到超时。
   */
  login?(options?: {
    onUrl?: (url: string) => void;
    onPrompt?: (prompt: LoginPrompt) => Promise<string>;
    signal?: AbortSignal;
  }): Promise<LoginResult>;

  /**
   * 登录回调是否必须从「浏览器所在机器的环回地址」打进来。
   *
   * 返回 `{port, path}` 表示需要有人在浏览器那台机器上把 `127.0.0.1:<port>` 转发到
   * 网关（由插件做，网关在容器里够不到用户笔记本）；`null` 表示不需要。
   *
   * **端口是随机的（`0`）时必须返回 `null`**：外部无法预告随机端口，硬报一个数字
   * 只会让插件转发到错端口。
   */
  loginLoopback?(): { port: number; path: string } | null;

  /** 校验凭据还能不能用，顺便取上游账号信息。失败抛错。 */
  probe?(account: Account): Promise<AccountProfile>;

  /**
   * 某个账号看得到的模型目录，用于 `/v1/models`。
   *
   * 按账号取而不是按通道缓存：不同号的套餐不同，目录可能不一样。
   */
  modelsOf(account: Account): Promise<ModelInfo[]>;

  /** 上游原始目录（保留 `lengths` / `reasoning` 等字段），只给 `/models` 页用。 */
  catalogOf?(account: Account): Promise<CatalogModel[]>;

  /**
   * 余额快照。`totalRemain` 是徽标和面板唯一读的数字。
   *
   * 失败请抛错：路由会包成 `{supported:false, error}` 仍以 200 返回，让界面显示 `—`
   * 而不是整块崩掉。
   */
  creditsOf(account: Account): Promise<Credits>;

  /** 上游真实签到状态。上游没有这个接口时返回 `null`；查询失败则抛错。 */
  checkinStatusOf?(account: Account): Promise<CheckinStatus | null>;

  /**
   * 领取今日签到。幂等由通道保证：领过返回 `status === 'already'` 而不是报错，
   * 只有真失败才返回 `'error'`。
   */
  checkinClaimOf?(account: Account): Promise<CheckinRecord>;

  /** 读本地签到记录。**同步、不发网络请求。** */
  lastCheckinOf?(account: Account): CheckinRecord | null;

  /**
   * 给这个账号换一套设备身份，返回要写回凭据的新值（不落盘，由账号层写）。
   *
   * 有些上游的签到按**设备**记而不是按账号，多号共用设备号会互相干扰（Trae 的 9074）。
   * 只生成新值、不发网络请求；不清本地签到记录。
   */
  rotateDeviceIdOf?(account: Account): Record<string, any> | null;

  /** 让上游注销这条会话。**只管上游、不碰本地账号**——删凭据从来不等于登出。 */
  logoutOf?(account: Account): Promise<void>;

  /**
   * 转发一次对话补全。
   *
   * 通道负责：调上游、把流翻译成 OpenAI 形状、拿到 usage 时回调 `request.onUsage`。
   * 不负责：怎么发 HTTP 响应、怎么记账、怎么改账号状态——这三件都在路由层。
   *
   * 失败抛 `UpstreamError`，带上游状态码：401 → 路由标 `invalid`，429 → 标 `cooldown`。
   */
  chatAs(account: Account, request: ChatRequest): Promise<ChatOutcome>;
}
