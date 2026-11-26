/**
 * 账号域：列表（`GET /api/accounts`）+ 所有写操作。
 *
 * ## 为什么写操作也放这里
 *
 * 页面只负责「按钮长什么样、点下去之后说什么」，**路径和请求体形状只在这一个文件里**。
 * 分散到各视图里的话，同一个 `PATCH /api/accounts/:id` 会在账号页、详情页各写一份，
 * 字段名打错的表现是「保存了但没生效」，而两边都返回 200。
 *
 * ## 登录是两步，不是一个请求
 *
 * ```
 * POST /api/accounts/:channel/login     → 起任务，立刻回 { task }
 * GET  /api/accounts/:channel/login/:id → 轮询状态，直到 state !== 'running'
 * ```
 *
 * 第二步不能省：授权链接（`task.url`）、短信验证码输入（`task.prompt`）都是在任务跑起来
 * **之后**才出现的。任务句柄放在页面地址的 query 里（`?channel=…&task=…`），刷新能接上——
 * 网关侧的任务本来就不会因为浏览器刷新而消失。
 */
import { api } from './client';

export interface AccountRow {
  id: string;
  channelId: string;
  channelLabel: string;
  idPrefix: string;
  seq: number;
  label: string;
  status: string;
  statusMessage: string | null;
  cooldownUntil: number | null;
  profile: { uid?: string | null; username?: string | null; domain?: string | null } | null;
  createdAt: number;
  /* ---- 积分：官方口径，只读。**各通道的单位和重置规则都不同，不可相加** ---- */
  /** 剩余。拉不到是 `null`（显示 `—`），**不是 0**。 */
  totalRemain: number | null;
  /** 官方给的「已用」。`null` = 该通道不提供（显示 `—`，**不是 0**）。 */
  usedTotal: number | null;
  /** 官方给的「总额度」。 */
  limitTotal: number | null;
  /** 上一次真实读取上游时的剩余（配合 `prevAt` 显示「较上次 ±X」）。 */
  prevRemain: number | null;
  /** 上一次真实读取的时间；没有上一次就是 `null`。 */
  prevAt: number | null;
  /** 本次余额快照的时间（缓存命中时是那次真实读取的时间）。 */
  creditsAt: number | null;
  /* ---- 用量：网关账本统计，token **可以**跨通道相加 ---- */
  /** 今日 token（输入 + 输出）。该通道不提供 token 时是 0。 */
  todayTokens: number;
  /** 累计 token。 */
  totalTokens: number;
  /**
   * 这个号自己的签到开关。**不含通道总闸**——通道关着时这里仍是它自己的值，
   * 界面据此把开关置灰但保留状态。真正「今天会不会自动签」= 通道的 `checkinEnabled` && 这个。
   */
  checkinEnabled: boolean;
}

export interface ChannelCapability {
  id: string;
  label: string;
  idPrefix: string;
  /** 报给上游的客户端版本号。字段名各家不同（`clientVersion` / `channelVersion` / `appVersion`），所以是开放字典。 */
  identity: Record<string, string>;
  multiAccount: boolean;
  canLogin: boolean;
  canLogout: boolean;
  canRotateDevice: boolean;
  canVerify: boolean;
  canCheckin: boolean;
  /**
   * 登录要不要先开空白窗接授权页。
   * `false` = 表单式（短信验证码 / 粘贴 cookie），开了只会留一个白屏标签页。
   */
  opensWindow: boolean;
  /**
   * 上游会不会报 token 用量。`false` 时这个通道的账号在账本里恒为 0，
   * 界面要显示 `—` 并说明「该通道不提供」——**0 会被读成「用过但没消耗」**。
   * 目前只有 Qoder 是 `false`。
   */
  reportsTokens: boolean;
  accounts: string[];
}

export interface AccountsResponse {
  accounts: AccountRow[];
  channels: ChannelCapability[];
}

export function getAccounts(): Promise<AccountsResponse> {
  return api.get<AccountsResponse>('/api/accounts');
}

/* ------------------------------ 登录任务 ------------------------------ */

/** 有 `options` 的 prompt 前端渲染成按钮，让用户点选而不是打字。 */
export interface LoginPromptOption {
  value: string;
  label: string;
  hint?: string;
  /** 头像 URL（账号选择用）。有它就渲染成带头像的卡片。 */
  avatar?: string;
  /** 第二行副标题，比如租户名。 */
  subtitle?: string;
  /**
   * 这一项选不了。**仍然显示**，只是灰掉——用户得知道上游给了哪些方式，
   * 不然会以为网关漏了。典型：豆包 2046 的 `oauth_douyin_verify`（要跳抖音授权）。
   */
  disabled?: boolean;
}

/** 表单式登录（Loomy / 豆包的短信验证码）当前要用户填的一步。 */
export interface LoginPrompt {
  /** 一次登录里可能有多个 prompt（手机号 → 验证码），按 id 去重。 */
  id: string;
  label: string;
  placeholder?: string;
  inputType?: 'text' | 'number' | 'password';
  submitLabel?: string;
  /** 预设选项。有它就渲染按钮组。 */
  options?: LoginPromptOption[];
  /** 要用户完成一次验证。有它就嵌 iframe 显示验证页。 */
  challenge?: LoginPromptChallenge;
  /** 二维码地址（data URI 或远程图片）。有它就渲染成图片让用户用已登录的 App 扫。 */
  qrCode?: string;
  /** 要用户填 OTP 验证码时给位数。有它就渲染大格子输入框。 */
  otpLength?: number;
  /** 短信验证要的三段信息（号码 / 正文 / 被验证手机号）。 */
  sms?: LoginPromptSms;
}

/** 短信验证要显示的三段信息。 */
export interface LoginPromptSms {
  channelMobile: string;
  content: string;
  mobile: string;
}

/** 让用户做一次验证的材料（上游 verify_center_decision_conf）。 */
export interface LoginPromptChallenge {
  url: string;
  code: string;
  subtype: string;
  ticket: string;
}

export interface LoginTask {
  taskId: string;
  channelId: string;
  /** `cancelled` 是用户主动放弃，**不是失败**——两者话术不同。 */
  state: 'running' | 'done' | 'error' | 'cancelled';
  /** 授权页地址。Qoder 会先后给两个（先设备流、再对话态），要按「变化」处理。 */
  url: string | null;
  prompt: LoginPrompt | null;
  message: string | null;
  startedAt: number;
  finishedAt: number | null;
  accountId: string | null;
  /**
   * 上游要求完成的验证（图形验证码）。有它就在弹窗里嵌验证页让用户点。
   * **为 null 不代表没风控**：豆包 2046 走的是登录流程里的 `prompt`（带二维码/短信号码），
   * 不是这里的 challenge。
   */
  challenge: LoginChallenge | null;
}

/**
 * 上游出的验证题。数据来自响应的 `verify_center_decision_conf`，
 * **不是**顶层 `captcha` 字段（那个一直是空的）。
 */
export interface LoginChallenge {
  /** 验证页地址，直接嵌 iframe。 */
  url: string;
  /** 挑战码（`decision_conf.detail`），作为 `challenge_code` 传给验证页。 */
  code: string;
  /** 验证类型：slide / 3d / text / icon / whirl / semantic_reasoning。 */
  subtype: string;
  /** 验证票据，验证通过后带回原请求。 */
  ticket: string;
  /** 触发这次验证的上游事件。 */
  event: string;
}

export function startLogin(channelId: string): Promise<{ ok: true; task: LoginTask }> {
  return api.post<{ ok: true; task: LoginTask }>(`/api/accounts/${encodeURIComponent(channelId)}/login`);
}

export function getLoginTask(channelId: string, taskId: string): Promise<LoginTask> {
  return api.get<LoginTask>(
    `/api/accounts/${encodeURIComponent(channelId)}/login/${encodeURIComponent(taskId)}`,
  );
}

/** 回填一个 prompt（短信码 / 手机号）。任务不在等输入时是 400。 */
export function answerLoginPrompt(channelId: string, taskId: string, value: string): Promise<{ ok: true }> {
  return api.post<{ ok: true }>(
    `/api/accounts/${encodeURIComponent(channelId)}/login/${encodeURIComponent(taskId)}/answer`,
    { value },
  );
}

/** 取消登录。**幂等**：任务已结束也回 200，用户连点两下不该看到报错。 */
export function cancelLoginTask(
  channelId: string,
  taskId: string,
): Promise<{ ok: true; cancelled: boolean; existed: boolean }> {
  return api.delete<{ ok: true; cancelled: boolean; existed: boolean }>(
    `/api/accounts/${encodeURIComponent(channelId)}/login/${encodeURIComponent(taskId)}`,
  );
}

/* ------------------------------ 账号动作 ------------------------------ */

/** 检测凭据。会真的打一次上游，失败是 502（永久失效时网关会把账号标成「凭据失效」）。 */
export function verifyAccount(id: string): Promise<{ ok: true; profile: Record<string, unknown> }> {
  return api.post<{ ok: true; profile: Record<string, unknown> }>(`/api/accounts/${encodeURIComponent(id)}/verify`);
}

/**
 * 改账号。`label` 空串会被忽略；`status` **只接受** `disabled` / `ready`——
 * `cooldown` / `invalid` 是网关按上游反应写的，人手设一个「凭据失效」只会让人以为真坏了。
 */
export function patchAccount(
  id: string,
  patch: { label?: string; status?: 'disabled' | 'ready' },
): Promise<{ ok: true; account: unknown }> {
  return api.patch<{ ok: true; account: unknown }>(`/api/accounts/${encodeURIComponent(id)}`, patch);
}

/** 删账号（连凭据一起）。不可撤销：它名下那批模型 id 会从模型列表里消失。 */
export function deleteAccount(id: string): Promise<{ ok: true; removed: string }> {
  return api.delete<{ ok: true; removed: string }>(`/api/accounts/${encodeURIComponent(id)}`);
}

/** 上游退出：只注销会话，**不删账号文件**。上游失败也是成功（回 `upstream` 原因）。 */
export function logoutAccount(
  id: string,
): Promise<{ ok: true; upstream: string | null; removed: false }> {
  return api.post<{ ok: true; upstream: string | null; removed: false }>(
    `/api/accounts/${encodeURIComponent(id)}/logout`,
  );
}

/** 换设备号。`changed: false` 表示这个通道不支持（或没有可换的字段），不是失败。 */
export function rotateDevice(
  id: string,
): Promise<{ ok: true; changed: boolean; fields?: string[]; reason?: string }> {
  return api.post<{ ok: true; changed: boolean; fields?: string[]; reason?: string }>(
    `/api/accounts/${encodeURIComponent(id)}/rotate-device`,
  );
}

/* ------------------------------ 签到开关 ------------------------------ */

/** 改账户级签到开关。关掉后不再自动签，手动点仍然可以签。 */
export function setAccountCheckin(
  id: string,
  enabled: boolean,
): Promise<{ ok: true; account: string; checkinEnabled: boolean }> {
  return api.patch<{ ok: true; account: string; checkinEnabled: boolean }>(
    `/api/accounts/${encodeURIComponent(id)}/checkin-switch`,
    { enabled },
  );
}

/* ------------------------------ 主动刷新积分 ------------------------------ */

/**
 * 手动刷新后的余额。字段名和 `AccountRow` 上那几列**一一对应**，界面直接覆盖即可。
 *
 * `error` 是「这次没读到的原因」——点了按钮就必须能知道为什么数字没变，
 * 否则用户会以为按钮坏了。
 */
export interface CreditRefreshRow {
  totalRemain: number | null;
  usedTotal: number | null;
  limitTotal: number | null;
  prevRemain: number | null;
  prevAt: number | null;
  creditsAt: number | null;
  error: string | null;
}

export interface CreditRefreshResponse {
  credits: Record<string, CreditRefreshRow>;
}

/**
 * 主动去上游读余额（绕过网关那 30 秒缓存）。
 *
 * 账号级和通道级只有路径不同，返回体同构；页面按 id 覆盖那几行，不整页重拉——
 * 重拉会打断「更多」菜单这类界面状态。
 */
export function refreshAccountCredits(id: string): Promise<CreditRefreshResponse> {
  return api.post<CreditRefreshResponse>(`/api/accounts/${encodeURIComponent(id)}/credits`);
}

export function refreshChannelCredits(channelId: string): Promise<CreditRefreshResponse> {
  return api.post<CreditRefreshResponse>(`/api/channels/${encodeURIComponent(channelId)}/credits`);
}
