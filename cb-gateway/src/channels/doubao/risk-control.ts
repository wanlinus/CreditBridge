// 豆包风控错误的统一表示。
//
// 为什么单独一个模块：风控在**三个地方**出现，处理方式必须一致——
// ① 登录（send_code / sms_login 选号）
// ② 对话（710022004）
// ③ 额度查询
//
// 三者都要满足同一条：**不要把账号标成 `invalid`**。风控是临时的（等一会儿或人工过验证就好），
// `invalid` 会让号永远显示「失效」，用户只能删号重登——而重登还会再撞风控。
//
// 上游的报错文案会骗人：`710022004` 的 `error_msg` 写的是 `rate limited`，
// 但 `decision` 里是 `shark_admin` / `semantic_reasoning`（风控要真人验证）。
// 所以判断只能看**错误码 + 响应结构**，不能看文案。

import { UpstreamError } from '../../shared/upstream-error.ts';

/** 风控要求「二次身份验证」时的默认冷却时长。实测停 5 分钟不恢复，给 10 分钟。 */
const RISK_COOLDOWN_MS = 10 * 60 * 1000;

/** 上游风控码。**这些码全部按「临时不可用」处理**，不封号。 */
const RISK_CONTROL_CODES = new Set([
  2046, // 选号被拦（「为保证账号安全，暂不支持此操作」）
  1105, // 风控出题（「滑动滑块进行验证」）——**带 verify_center_decision_conf，能弹验证码**
  4037, // SMS_SECURITY_BLOCKED
  4038, // SEND_CODE_SECURITY_BLOCKED
  4048, // DOUYIN_ACCOUNT_SECONDARY_BLOCKED
  710022004, // 对话风控（文案写 rate limited，实际是风控）
  1203, // 验证码错误次数过多（也算临时）
  1206, // VERIFY_CODE_EXCEED
  2068, // BIND_TOO_OFTEN
]);

export interface RiskControlInfo {
  code: number;
  /** 上游原文，给日志和排查用。 */
  message: string;
  /** 响应里 `ies_safety_diversion_tag`，`mfa` 表示要二次验证。 */
  diversion: string;
  /** 是不是「账号开了仅常用设备登录」这类设备限制。 */
  deviceBound: boolean;
  /** 冷却到什么时候。 */
  retryAt: number;
  /**
   * 服务端出的验证题。**为空表示没有可用的验证入口。**
   *
   * 两种风控的出题方式完全不同（2026-11-26 逆向确认）：
   * - `1105`（发码阶段）→ `verify_center_decision_conf.detail`，纯前端验证页，**能做**
   * - `2046`（选号阶段）→ `verify_ways` 数组，走下面的 `verifyWays`
   */
  challenge: CaptchaChallenge | null;
  /**
   * 上游给的验证方式（2046 的 `verify_ways`）。**每条都是纯 HTTP 的**——
   * 2026-11-26 挖完懒加载 chunk 后确认，客户端的那层 JSBridge 只用来通知宿主
   * 「验证完了、关窗口」，真正的验证请求网关自己就能发。见 `verify-ways.ts`。
   */
  verifyWays: VerifyWay[];
  /**
   * 2046 响应里重放原请求要用的上下文。**没有它验证成功也白搭**——
   * SDK 的做法是「验证通过后把 `biz_params` 合进原请求、query 加 `isResend=1`」重发一次。
   */
  verification: VerificationContext | null;
}

/**
 * 2046 响应里跟「验证完成后怎么继续」有关的字段。
 *
 * 从 passport SDK 的 `processPlugin`（chunk `6151`）逆向出来：
 * ```js
 * const s = this.getResendData(n?.data, { ...e?.biz_params, ...r?.bizParams });
 * return this.request({ ...n, params: { ...n.params, isResend: true }, data: s });
 * ```
 * 也就是说 `biz_params` 会被**合并进原请求的表单**，`isResend:true` 进 query。
 */
export interface VerificationContext {
  /** 重放原请求时合并进表单。 */
  bizParams: Record<string, string>;
  /** 走到 2046 的原始请求路径（`/passport/web/sms_login/` 这类）。由调用方填。 */
  resendPath: string;
  /** 原始请求的表单，重放前要把 `bizParams` 合进来。由调用方填。 */
  resendForm: Record<string, string>;
  /** 验证票据，`verify_ticket`。`upsms/verify` 要它。 */
  verifyTicket: string;
  /** 加密后的 uid，`verify_ways` 里的各个接口都要它。 */
  encryptUid: string;
  /** `event_params.verify_scene`（`sms_login` 这类）。`get_qrcode` / `send_push` 的 `scene` 用它。 */
  verifyScene: string;
}

/** 上游给的一种验证方式。 */
export interface VerifyWay {
  /** `qr_code_verify` / `mobile_up_sms_verify` / `push_verify` / `oauth_douyin_verify` 等。 */
  way: string;
  /** 中文说明。 */
  label: string;
  /** 这条方式「需要用户手里有什么」，直接显示在选项下方。 */
  hint: string;
  /** `mobile_up_sms_verify` 才有：要发短信到哪个号码。 */
  channelMobile?: string;
  /** `mobile_up_sms_verify` 才有：短信内容。 */
  smsContent?: string;
  /** `mobile_up_sms_verify` 才有：被验证的手机号（脱敏）。 */
  mobile?: string;
  /** `oauth_douyin_verify` 才有。 */
  platformName?: string;
}

/**
 * 验证方式的中文名。值来自豆包 `9856.e43498a1.js` 的 i18n 表。
 */
const VERIFY_WAY_LABELS: Record<string, string> = {
  qr_code_verify: '使用原设备扫码',
  qr_code_verify_pc: '扫码验证',
  mobile_up_sms_verify: '发送短信验证码',
  mobile_sms_verify: '接收短信验证码',
  push_verify: '已登录设备辅助验证',
  oauth_douyin_verify: '验证抖音账号',
  oauth_apple_verify: '验证 Apple ID',
  pwd_verify: '密码验证',
  mobile_auth_face_verify: '刷脸验证',
};

/**
 * 每种验证方式「需要用户手里有什么」。**这是给用户选方式的依据**——
 * 只说方式名，用户不知道自己手上有没有那个条件。
 */
export const VERIFY_WAY_HINTS: Record<string, string> = {
  mobile_up_sms_verify: '只需要手机能发短信：把指定内容发到指定号码',
  qr_code_verify: '需要另一台已经登录豆包的设备：扫二维码确认',
  push_verify: '需要另一台已经登录豆包的设备在线：会弹确认框',
  oauth_douyin_verify: '需要抖音 App 授权（要跳第三方页面，网关做不了）',
};

/**
 * 查验证决策的接口。**纯 HTTP GET，不需要登录态**（2026-11-26 实测）。
 *
 * 从验证页 chunk（`second-account-verification-app_page`）里挖出来的：
 * ```js
 * t = { method:"GET", url:"/passport/safe/query_decision/", params: e }
 * ```
 *
 * 唯一必填参数是 `verify_way_name_list`（不给回 `code=3 缺少参数`）。
 * 给了之后回 `2037 当前暂无可用验证方式` —— 那是 `encrypt_uid` 过期的表现，
 * 说明参数结构对、接口通。它在 `accounts.doubao.com/passport/safe/` 下，
 * 和 `sms_login` 同域，**不像 `/alice/*` 那样要登录态**。
 *
 * 这条路还没走完：`mobile_up_sms_verify` 用户发完短信后的「查收」接口没找到。
 * 详见 `private/docs/recon/doubao-2046-verify-ways.md`。
 */
export const QUERY_DECISION_PATH = '/passport/safe/query_decision/';

/** 服务端出的验证题。有它才能让用户点图形。 */
export interface CaptchaChallenge {
  /**
   * 挑战数据（`verify_center_decision_conf.detail`，约 392 字符）。
   * 这是验证页要的 `challenge_code`——**不是响应顶层的 `captcha` 字段**
   * （那个一直是空的，2026-11-26 之前我一直查错字段）。
   */
  code: string;
  /** 验证页地址。 */
  url: string;
  /** 验证类型：slide / 3d / text / icon / whirl / semantic_reasoning。 */
  subtype: string;
  /** 验证票据，验证通过后带回原请求。 */
  ticket: string;
  /** 触发这次验证的上游事件（`tt_send_sms_login` 这类）。 */
  event: string;
}

/**
 * 验证页地址。客户端用 `rmc.bytedance.com/verifycenter/captcha`（实测 200，9484 字节）。
 * `verify.zijieapi.com/verifycenter/captcha/v2` 是同一个页面的另一个入口，裸请求 404。
 */
export const CAPTCHA_PAGE_URL = 'https://rmc.bytedance.com/verifycenter/captcha';

/** 这个错误码是不是风控。 */
export function isRiskControlCode(code: unknown): boolean {
  const value = Number(code);
  return Number.isFinite(value) && RISK_CONTROL_CODES.has(value);
}

/**
 * 从响应里提取风控信息。`doc` 是上游返回的 JSON。
 *
 * `deviceBound` 的判断依据是**响应里有没有 mfa 标记**：有 `ies_safety_diversion_tag: "mfa"`
 * 说明服务端认为这台设备不可信，要走二次验证——那通常是设备号不对，换对设备号就能过。
 * 没有 mfa 标记的风控是频率类的，等一会儿就行。
 */
export function riskControlOf(doc: any, now = Date.now()): RiskControlInfo | null {
  const code = Number(doc?.data?.error_code ?? doc?.error_code ?? doc?.code);
  if (!isRiskControlCode(code)) return null;

  const message = String(doc?.data?.description || doc?.error_msg || doc?.message || '').trim();
  const diversion = String(doc?.data?.common_params?.ies_safety_diversion_tag || '');

  return {
    code,
    message,
    diversion,
    deviceBound: diversion === 'mfa' || code === 2046,
    retryAt: now + RISK_COOLDOWN_MS,
    challenge: challengeOf(doc),
    verifyWays: verifyWaysOf(doc),
    verification: verificationOf(doc),
  };
}

/**
 * 提取 2046 的 `verify_ways`。
 *
 * 四种方式都能纯 HTTP 做完（2026-11-26 挖完懒加载 chunk `1648` / `2728` 确认）：
 * 客户端弹的那个验证页靠 JSBridge 只是通知宿主「关窗口」，请求本身没签名、没原生依赖。
 */
function verifyWaysOf(doc: any): VerifyWay[] {
  const list = doc?.data?.verify_ways;
  if (!Array.isArray(list)) return [];
  return list
    .map((item: any) => {
      const way = String(item?.verify_way || '');
      if (!way) return null;
      const entry: VerifyWay = {
        way,
        label: VERIFY_WAY_LABELS[way] || way,
        hint: VERIFY_WAY_HINTS[way] || '',
      };
      if (item?.channel_mobile) entry.channelMobile = String(item.channel_mobile);
      if (item?.sms_content) entry.smsContent = String(item.sms_content);
      if (item?.platform_screen_name) entry.platformName = String(item.platform_screen_name);
      if (item?.mobile) entry.mobile = String(item.mobile);
      return entry;
    })
    .filter((item): item is VerifyWay => item !== null);
}

/**
 * 把 2046 响应里「重放原请求」需要的字段捞出来。
 *
 * `biz_params` 是 SDK 的合入源，缺了它验证通过也没法继续。
 * `resendPath` / `resendForm` 上游不给——那是**我们自己刚发出去的那个请求**，
 * 由调用方（登录流程）填，所以这里留空。
 */
function verificationOf(doc: any): VerificationContext | null {
  const data = doc?.data;
  if (!data) return null;
  const rawBiz = data.biz_params;
  if (!rawBiz || typeof rawBiz !== 'object') return null;
  const bizParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawBiz)) {
    if (value === null || value === undefined) continue;
    bizParams[key] = String(value);
  }
  return {
    bizParams,
    resendPath: '',
    resendForm: {},
    verifyTicket: String(data.verify_ticket || ''),
    encryptUid: String(data.encrypt_uid || ''),
    verifyScene: String(data.event_params?.verify_scene || data.passport_scene || ''),
  };
}

/**
 * 从响应里提取验证题。
 *
 * **挑战数据在 `verify_center_decision_conf` 里，不在顶层的 `captcha` 字段。**
 * 顶层 `captcha` / `desc_url` 一直是空字符串（那是网页版的老路径），
 * 2026-11-26 之前一直查这两个，所以误判成「上游不出题」。
 *
 * 真实结构（`send_code` 被风控时的实测响应）：
 * ```json
 * {
 *   "error_code": 1105,
 *   "description": "滑动滑块进行验证",
 *   "verify_center_decision_conf": "{\"subtype\":\"slide\",\"detail\":\"-sWa519...\",\"verify_ticket\":\"VTIDEF...\",\"verify_event\":\"tt_send_sms_login\"}",
 *   "verify_ticket": "VTIDEF..."
 * }
 * ```
 */
function challengeOf(doc: any): CaptchaChallenge | null {
  const raw = doc?.data?.verify_center_decision_conf;
  if (!raw) return null;

  let conf: any = null;
  try {
    conf = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }

  const detail = String(conf?.detail || '');
  if (!detail) return null;

  return {
    code: detail,
    url: CAPTCHA_PAGE_URL,
    subtype: String(conf?.subtype || ''),
    ticket: String(conf?.verify_ticket || doc?.data?.verify_ticket || ''),
    event: String(conf?.verify_event || ''),
  };
}

/**
 * 把风控包装成 `UpstreamError`，状态码 429。
 *
 * **429 而不是 401/502**：路由层看到 429 会把账号标 `cooldown` 并带恢复时间，
 * 看到 401 会标 `invalid`（永久失效）。风控是临时的，标 invalid 是误伤。
 *
 * 错误信息里带上**可执行建议**（`riskControlAdvice`）——只说「被风控了」用户没法处理。
 */
export function riskControlError(
  info: RiskControlInfo,
  context: string,
  options: { enterpriseAccount?: boolean } = {},
): UpstreamError {
  return new UpstreamError(
    429,
    `${context}被豆包风控拦住了（${info.message || `上游 ${info.code}`}）。${riskControlAdvice(info, options)}`,
    {
      code: 'doubao_risk_control',
      retryAt: info.retryAt,
      // 有题才带上，界面据此决定要不要渲染验证码。空题不传，免得界面白等。
      challenge: info.challenge,
    },
  );
}

/**
 * 一条验证方式都做不了时的错误。
 *
 * 目前只有一种情况走到这里：`verify_ways` 里只剩 `oauth_douyin_verify` 这类
 * 要跳第三方授权页的方式。文案要说清「是哪种方式做不了」，别只说被拦了。
 */
export function noVerifiableWayError(info: RiskControlInfo): UpstreamError {
  const names = info.verifyWays.map((way) => way.label).join(' / ') || '（上游没给验证方式）';
  return new UpstreamError(
    429,
    `豆包要求二次身份验证，但上游这次只给了「${names}」——这类要跳第三方授权页，网关做不了。` +
      '三个办法：① 重试时选「用豆包客户端的设备号」；' +
      '② 在豆包 App 里关掉「24 小时内仅允许常用设备登录」；' +
      '③ 在豆包客户端里登录后用「导入 cookie」。',
    { code: 'doubao_verify_unavailable', retryAt: info.retryAt },
  );
}

/**
 * 给用户看的操作建议。**必须可执行**——只说「被风控了」等于没说。
 *
 * 客户端的做法（2026-11-26 逆向确认）：弹验证码（`TTGCaptcha` / verifyCenter），
 * 用户在验证页上完成滑动/点选，通过后拿 `verify_ticket` 再发请求。
 * 网关把这个验证页嵌进登录弹窗，让用户照着做——和客户端完全一样。
 */
export function riskControlAdvice(info: RiskControlInfo, options: { enterpriseAccount?: boolean } = {}): string {
  // 有题可做：直接让用户点（客户端同款流程）。
  if (info.challenge) {
    const label = info.challenge.subtype ? challengeName(info.challenge.subtype) : '图形验证码';
    return `上游要求完成一次验证（${label}）。在登录弹窗里按提示操作，通过后会自动继续。`;
  }
  // 2046：上游给了验证方式，网关能在界面上带用户做完。
  if (info.verifyWays.length > 0) {
    const names = info.verifyWays.map((way) => way.label).join(' / ');
    return `上游要求二次身份验证，可用的方式：${names}。在登录弹窗里选一种做完就行。`;
  }
  if (options.enterpriseAccount) {
    return (
      '这个号是企业/飞书账号，上游可能要求设备装飞书安全组件（LSA），网关满足不了。' +
      '请在豆包客户端里登录它，再用「导入 cookie」添加。'
    );
  }
  if (info.deviceBound) {
    return (
      '账号开了「24 小时内仅允许常用设备登录」，上游没给可用的验证入口。三个办法：' +
      '① 重试时选「用豆包客户端的设备号」，填客户端里的那个（User Data/ahanet/tt_net_config.config 里 device_id&#*<数字>）；' +
      '② 在豆包 App 里关掉这个设备限制（账号安全设置里）；' +
      '③ 在豆包客户端里登录后用「导入 cookie」。'
    );
  }
  const minutes = Math.max(1, Math.round((info.retryAt - Date.now()) / 60000));
  return `这是频率类的风控，等 ${minutes} 分钟左右再试，或在豆包客户端里过一次验证。`;
}

/** 验证类型的中文名。值来自豆包 captcha.js 的类型表。 */
export function challengeName(subtype: string): string {
  const names: Record<string, string> = {
    slide: '滑动滑块',
    '3d': '3D 验证',
    text: '输入文字',
    icon: '点选图标',
    whirl: '旋转图片',
    semantic_reasoning: '按提示点选',
  };
  return names[subtype] || '图形验证码';
}

/**
 * 这次风控客户端会怎么处理。用于日志和排查，让人知道「上游要的是什么」。
 *
 * 逆向结论：豆包走的是图形验证码（`verify.zijieapi.com` + `TTGCaptcha`），
 * **不是**无感验证 —— `nocaptcha_client_compute.path_list` 里全是抖音 App 的接口，
 * 没有 doubao 的。所以别指望「客户端算个分就过」。
 */
export function riskControlChallengeOf(info: RiskControlInfo): string {
  if (!info.challenge) {
    // 2046 会带 verify_ways，但那些方式网关做不了——日志里标清楚是哪几种。
    const ways = info.verifyWays.length > 0 ? `，上游要求=${info.verifyWays.map((w) => w.way).join('/')}` : '';
    const suffix = `（无可执行的验证入口${ways}）`;
    if (info.deviceBound) return `device_bound${suffix}`;
    return `risk_control${suffix}`;
  }
  const label = info.challenge.subtype || '未知类型';
  return `verify_center_captcha（已出题：${label}，ticket=${info.challenge.ticket.slice(0, 12)}…）`;
}
