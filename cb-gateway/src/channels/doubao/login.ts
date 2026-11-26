// 豆包登录流程：短信验证码（含多账号选号）和 cookie 导入。
//
// HTTP 底座、cookie 罐、脱敏日志在 `passport.ts`；风控判定在 `risk-control.ts`。
// 这里只管「按什么顺序问用户什么、拿到什么就调哪个接口」。

import { UpstreamError } from '../../shared/upstream-error.ts';
import type { LoginPrompt, LoginResult } from '../../types.ts';
import { buildCredential, buildCredentialFromCookies, fetchProfile, verifyCredential } from './auth.ts';
import {
  CookieJar,
  SMS_TYPE,
  errorCodeOf,
  loginLog,
  messageOf,
  postForm,
  registerTtwid,
  setLoginLogger,
} from './passport.ts';
import { challengeName, noVerifiableWayError, riskControlError, riskControlOf } from './risk-control.ts';
import type { CaptchaChallenge, VerificationContext, VerifyWay } from './risk-control.ts';
import { beginVerify, canVerifyHere, confirmVerify, expireQrCode, finishVerification, refreshQrCode } from './verify-ways.ts';
import type { DoubaoCredential } from './auth.ts';

export { setLoginLogger };

/** 单字节 XOR 0x05 后转十六进制。上游所有「敏感」字段都是这个编码。 */
function encodeField(value: string): string {
  return Buffer.from([...value].map((char) => char.charCodeAt(0) ^ 0x05)).toString('hex');
}

/** 把用户输入的手机号规整成 `+86` 开头的 11 位。 */
function normalizePhone(raw: string): string {
  const digits = String(raw || '').replace(/[^\d]/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return `+86${digits}`;
  if (digits.length === 13 && digits.startsWith('86')) return `+${digits}`;
  if (/^1[3-9]\d{9}$/.test(digits)) return `+86${digits}`;
  throw new Error('手机号格式不正确（中国大陆 11 位，1 开头）');
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '').slice(-11);
  return digits.length === 11 ? `${digits.slice(0, 3)}****${digits.slice(-4)}` : phone;
}

/** 本文件的日志别名。前缀和 passport 那边一致，容器日志里能串起来。 */
const log = loginLog;

/**
 * ① 发短信验证码。返回 `mobile_ticket`（② 要用）。
 *
 * 手机号要先规范化成 `+86xxxxxxxxxxx` 再编码，否则服务端解出来对不上。
 *
 * **遇到风控会自动重试一次**：上游回 1105 时响应里带 `verify_center_decision_conf`
 * （`subtype` + 392 字符的 `detail` + `verify_ticket`），那是一次可完成的验证。
 * 交给 `onChallenge` 让前端渲染验证页，用户做完再发一次。和客户端流程一致。
 */
export async function sendSmsCode(
  deviceId: string,
  phone: string,
  jar: CookieJar,
  options: {
    signal?: AbortSignal;
    /** 让用户完成验证。返回 `true` 表示做完了，可以重试。 */
    onChallenge?: (challenge: CaptchaChallenge) => Promise<boolean>;
  } = {},
): Promise<{ mobileTicket: string; retryTime: number }> {
  const normalized = normalizePhone(phone);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reply = await postForm(
      deviceId,
      '/passport/web/send_code/',
      {
        mix_mode: '1',
        mobile: encodeField(normalized),
        type: encodeField(SMS_TYPE),
        is6Digits: '1',
        fixed_mix_mode: '1',
      },
      jar,
      { signal: options.signal },
    );

    const code = errorCodeOf(reply.doc);
    const mobileTicket = String(reply.doc?.data?.mobile_ticket || '');

    if (code === 0 && mobileTicket) {
      const retryTime = Number(reply.doc?.data?.retry_time) || 60;
      log(`验证码已发送（${maskPhone(normalized)}），${retryTime} 秒后可重发`);
      return { mobileTicket, retryTime };
    }

    // 风控先判：4037/4038/1206 这类不是「手机号错了」，别让用户去检查手机号。
    const risk = riskControlOf(reply.doc);
    if (risk) {
      // 有验证题且是第一次 → 让用户做完再重试一次。做不了就把错误抛出去。
      if (risk.challenge && attempt === 0 && typeof options.onChallenge === 'function') {
        log(`发码被风控，出题：${risk.challenge.subtype} ticket=${risk.challenge.ticket.slice(0, 12)}…`);
        if (await options.onChallenge(risk.challenge)) {
          log('用户完成验证，重发一次');
          continue;
        }
      }
      throw riskControlError(risk, '发验证码');
    }

    // 1204 = 手机号有问题 / 请求过频；其它码原样报出来，别猜。
    throw new Error(
      code === 1204
        ? `豆包发验证码失败：${messageOf(reply.doc) || '手机号无效或请求太频繁'}`
        : `豆包发验证码失败（上游 ${code}）：${messageOf(reply.doc) || '未返回 mobile_ticket'}`,
    );
  }

  throw new Error('豆包发验证码失败：验证后仍然被风控拦住，请稍后再试');
}

export interface SubAccount {
  secUid: string;
  name: string;
  /** 头像 URL。客户端就是拿它渲染账号选择界面的。 */
  avatar: string;
  /** 租户名（「飞书个人版」这类）。企业账号要显示，否则用户分不清两个「我」。 */
  tenantName: string;
  /** `passport_enterprise_user_type`：0 = 个人，非 0 = 企业/飞书账号。 */
  enterpriseType: number;
}

export interface VerifyResult {
  cookies: Record<string, string>;
  uid: string;
  /** 非空表示要选账号。 */
  accounts: SubAccount[];
  /** 选账号时要用，第二次请求得带上。 */
  smsCodeKey: string;
  mobileTicket: string;
}/**
 * ② 校验验证码。三种可能：登录成功 / 要选账号 / 失败。
 *
 * 1454 = 手机号绑了多个号，此时**还没有登录态**，要拿 `sms_code_key` + `sec_uid`
 * 再发一次（那次不带 code）。
 */
export async function verifySmsCode(
  deviceId: string,
  phone: string,
  code: string,
  mobileTicket: string,
  jar: CookieJar,
  signal?: AbortSignal,
): Promise<VerifyResult> {
  const normalized = normalizePhone(phone);
  const reply = await postForm(
    deviceId,
    '/passport/web/sms_login/',
    {
      mix_mode: '1',
      mobile: encodeField(normalized),
      code: encodeField(String(code).trim()),
      login_only: 'false',
      mobile_ticket: mobileTicket,
      fixed_mix_mode: '1',
    },
    jar,
    { signal },
  );

  const doc = reply.doc;
  const upstreamCode = errorCodeOf(doc);

  if (upstreamCode === 1454 && doc?.data?.exist_doubao_account === true) {
    const list = Array.isArray(doc.data.sub_account) ? doc.data.sub_account : [];
    const accounts: SubAccount[] = list
      .map((item: any) => ({
        secUid: String(item?.sec_uid || ''),
        name: String(item?.screen_name || item?.name || item?.nickname || ''),
        avatar: String(item?.avatar || ''),
        tenantName: String(item?.tenant_name || ''),
        enterpriseType: Number(item?.passport_enterprise_user_type) || 0,
      }))
      .filter((item: SubAccount) => item.secUid !== '');
    const smsCodeKey = String(doc.data.sms_code_key || '');
    if (accounts.length === 0 || !smsCodeKey) {
      throw new Error('这个手机号绑了多个账号，但上游没给出可选的账号列表，请在豆包客户端里登录');
    }
    // 这一步的响应已经往罐里塞了 passport_mfa_token / d_ticket，选号必须带着。
    log(`手机号绑了 ${accounts.length} 个账号，需要选择（罐里：${jar.names()}）`);
    return { cookies: jar.all(), uid: '', accounts, smsCodeKey, mobileTicket };
  }

  const uid = String(doc?.data?.user_id_str || doc?.data?.user_id || '');
  if (!uid) {
    // 风控先判：1203（验证码错误次数过多）走这里，别报成「验证码错了」让用户反复试。
    const risk = riskControlOf(doc);
    if (risk) throw riskControlError(risk, '校验验证码');
    throw new Error(`豆包验证码校验失败：${messageOf(doc) || '验证码错误或已过期'}`);
  }

  const cookies = jar.all();
  if (!cookies.sessionid) {
    throw new Error('豆包验证码校验通过但没拿到 sessionid，登录态没建立（可能被风控拦截）');
  }

  log(`验证码校验成功 uid=${uid}`);
  return { cookies, uid, accounts: [], smsCodeKey: '', mobileTicket };
}

/**
 * ③ 多账号时选定一个。**这次请求不带 `code`**（验证码已用过），
 * 改成带 `sms_code_key` + `sec_uid` + `register_new_user=false`。
 *
 * 能不能成功取决于罐里有没有 `passport_mfa_token` / `d_ticket`——
 * 那两个是上一步（校验验证码）的响应下发的。
 *
 * 被 2046 拦时**不直接报错**：上游给了验证方式（`verify_ways`），
 * 交给 `onVerify` 让用户在界面上做完，然后重放这次请求。
 */
export async function chooseAccount(
  deviceId: string,
  phone: string,
  verified: VerifyResult,
  secUid: string,
  jar: CookieJar,
  options: {
    signal?: AbortSignal;
    /**
     * 让用户完成一次 2046 验证。返回验证票据（非空 = 做完了，可以重放）；
     * 返回空串表示用户取消。
     */
    onVerify?: (ways: VerifyWay[], context: VerificationContext) => Promise<string>;
  } = {},
): Promise<{ cookies: Record<string, string>; uid: string }> {
  const normalized = normalizePhone(phone);
  // 表单和路径都要留一份：验证通过后重放的**就是这一次请求**。
  const form: Record<string, string> = {
    mix_mode: '1',
    mobile: encodeField(normalized),
    code: '',
    login_only: 'false',
    mobile_ticket: verified.mobileTicket,
    sms_code_key: encodeField(verified.smsCodeKey),
    register_new_user: 'false',
    sec_uid: secUid,
    fixed_mix_mode: '1',
  };
  const path = '/passport/web/sms_login/';

  let doc: any = (await postForm(deviceId, path, form, jar, { signal: options.signal })).doc;
  let uid = String(doc?.data?.user_id_str || doc?.data?.user_id || '');

  // 2046：上游给了验证方式。做完再重放一次（只做一次，重复验证说明设备号本身不对）。
  if (!uid && typeof options.onVerify === 'function') {
    const risk = riskControlOf(doc);
    if (risk?.verification && risk.verifyWays.length > 0) {
      const context: VerificationContext = { ...risk.verification, resendPath: path, resendForm: form };
      log(
        `选号被 2046 拦住，上游给的验证方式=${risk.verifyWays.map((w) => w.way).join('/')} ` +
          `device_id=${deviceId} encrypt_uid=${context.encryptUid ? '有' : '无'}`,
      );
      const ticket = await options.onVerify(risk.verifyWays, context);
      if (ticket) {
        log(`用户完成验证，重放选号请求（ticket=${ticket.slice(0, 12)}…）`);
        doc = await finishVerification(deviceId, context, ticket, jar, options.signal);
        uid = String(doc?.data?.user_id_str || doc?.data?.user_id || '');
      }
    }
  }

  if (!uid) {
    // 风控统一走 riskControlError（429）：裸 Error 会被路由层包成 502，
    // 而 502 不改账号状态，用户永远不知道是风控。
    const risk = riskControlOf(doc);
    if (risk) {
      log(
        `选号被风控：code=${risk.code} diversion=${risk.diversion || '(无)'} ` +
          `device_id=${deviceId} mfa_token=${jar.get('passport_mfa_token') ? '有' : '无'} ` +
          `d_ticket=${jar.get('d_ticket') ? '有' : '无'} ` +
          `multi_sids=${jar.get('multi_sids') ? '有' : '无'} ` +
          `有验证题=${risk.challenge ? `有（${risk.challenge.subtype}）` : '无'}`,
      );
      throw riskControlError(risk, '选号');
    }
    throw new Error(`豆包选号失败（上游 ${errorCodeOf(doc)}）：${messageOf(doc) || '未返回 user_id'}`);
  }

  const cookies = jar.all();
  if (!cookies.sessionid) {
    throw new Error('豆包选号后没拿到 sessionid，登录态没建立（可能被风控拦截）');
  }
  log(`选号登录成功 uid=${uid}`);
  return { cookies, uid };
}

/**
 * 跑一次登录。先让用户选方式（按钮，不是让用户输 1/2）：
 * - **短信验证码**：输手机号收验证码，多账号会列出账号让人点选。
 * - **导入 cookie**：从豆包客户端/浏览器复制 Cookie 整串贴进来，任何情况都能用。
 *
 * `knownDeviceId` 来自已有账号的凭据或 `QB_DOUBAO_DEVICE_ID`。
 * **它决定风控会不会出现**：豆包账号可以设「24 小时内仅允许常用设备登录」，
 * 而「常用设备」按 `device_id` 认。
 */
export async function runDoubaoLogin(
  options: {
    onPrompt?: (prompt: LoginPrompt) => Promise<string>;
    signal?: AbortSignal;
    /** 该通道已有账号用的设备号，或运维配的环境变量。没有就问用户。 */
    knownDeviceId?: string;
  } = {},
): Promise<LoginResult> {
  const ask = options.onPrompt;
  if (typeof ask !== 'function') {
    throw new Error('豆包登录需要表单交互（onPrompt），请通过网关账号页发起');
  }

  const method = await ask({
    id: 'method',
    label: '豆包怎么登录',
    submitLabel: '下一步',
    options: [
      {
        value: 'sms',
        label: '短信验证码',
        hint: '输手机号收验证码，绑了多个号会列出来让你选',
      },
      {
        value: 'cookie',
        label: '导入 cookie',
        hint: '从豆包客户端复制 Cookie。短信走不通时用这个',
      },
    ],
  });

  if (method.trim() === 'cookie') {
    return runCookieLogin(ask, options.signal);
  }
  return runSmsLogin(ask, options.signal, options.knownDeviceId);
}

/** 导入 cookie：把整串贴进来，验活后落成账号。任何情况都能用。 */
async function runCookieLogin(
  ask: (prompt: LoginPrompt) => Promise<string>,
  signal?: AbortSignal,
): Promise<LoginResult> {
  const raw = await ask({
    id: 'cookie',
    label: '粘贴豆包 cookie',
    placeholder: 'sessionid=…; sid_tt=…; uid_tt=…（从豆包客户端或浏览器复制整串）',
    inputType: 'password',
    submitLabel: '导入',
  });
  if (signal?.aborted) throw new Error('登录已取消');

  const credential = buildCredential(raw);
  const failure = await verifyCredential(credential);
  if (failure) {
    throw new Error(`这份 cookie 用不了：${failure}。请在豆包客户端里重新登录后导出完整 cookie`);
  }

  const profile = await fetchProfile(credential);
  log(`cookie 导入成功 uid=${profile?.uid || credential.uid}`);
  return {
    credential,
    profile: { uid: profile?.uid || credential.uid, username: profile?.username || '' },
    label: profile?.username || `豆包 ${credential.uid.slice(-6)}`,
  };
}

/**
 * 短信验证码登录。三步共享同一个 cookie 罐，多账号时走选号。
 *
 * **设备号决定风控会不会出现**：客户端 46 个请求全程用同一个 `device_id`，
 * 从不更换；随机号会被判成新设备。
 */
async function runSmsLogin(
  ask: (prompt: LoginPrompt) => Promise<string>,
  signal?: AbortSignal,
  knownDeviceId?: string,
): Promise<LoginResult> {
  const deviceId = await resolveDeviceId(ask, knownDeviceId);
  const jar = new CookieJar();
  log(`开始短信登录，device_id=${deviceId}${knownDeviceId ? '（复用已有账号）' : ''}`);

  // 先注册 ttwid：客户端页面一加载就有它，passport 请求全程带着。
  await registerTtwid(jar, signal);
  log(`ttwid 注册完成，罐里=${jar.names()}`);

  const phone = (await ask({
    id: 'phone',
    label: '输入豆包绑定的手机号',
    placeholder: '中国大陆手机号（1 开头 11 位）',
    inputType: 'text',
    submitLabel: '发送验证码',
  })).trim();
  if (signal?.aborted) throw new Error('登录已取消');
  if (!phone) throw new Error('未输入手机号');

  log(`发验证码 phone=${maskPhone(normalizePhone(phone))} device_id=${deviceId}`);
  const { mobileTicket } = await sendSmsCode(deviceId, phone, jar, {
    signal,
    onChallenge: (challenge) => askChallenge(ask, challenge),
  });
  log(`发码成功 ticket=${mobileTicket} 罐里=${jar.names()}`);

  const code = (await ask({
    id: 'code',
    label: '输入短信验证码',
    placeholder: '6 位验证码',
    inputType: 'number',
    submitLabel: '登录',
  })).trim();
  if (signal?.aborted) throw new Error('登录已取消');
  if (!code) throw new Error('未输入验证码');

  log(`校验验证码 device_id=${deviceId}`);
  const verified = await verifySmsCode(deviceId, phone, code, mobileTicket, jar, signal);
  log(`校验完成 uid=${verified.uid || '(无)'} 账号数=${verified.accounts.length} 罐里=${jar.names()}`);

  let cookies = verified.cookies;
  let uid = verified.uid;
  if (verified.accounts.length > 0) {
    log(`可选账号：${verified.accounts.map((a) => `${a.name}(企业${a.enterpriseType})`).join(' / ')}`);
    const secUid = await askAccount(ask, verified.accounts);
    log(`选号 sec_uid=${secUid.slice(-8)} 罐里=${jar.names()}`);
    const chosen = await chooseAccount(deviceId, phone, verified, secUid, jar, {
      signal,
      onVerify: (ways, context) => askVerify(ask, deviceId, ways, context, jar, signal),
    });
    cookies = chosen.cookies;
    uid = chosen.uid;
  }

  const credential: DoubaoCredential = buildCredentialFromCookies(cookies, { deviceId });
  const profile = await fetchProfile(credential);
  log(`登录成功 uid=${profile?.uid || uid}`);

  return {
    credential,
    profile: { uid: profile?.uid || uid, username: profile?.username || '' },
    label: profile?.username || `豆包 ${maskPhone(phone)}`,
  };
}

/**
 * 定设备号。优先级：已有账号凭据 → `QB_DOUBAO_DEVICE_ID` → 让用户选。
 *
 * **客户端设备号是首选**：账号开了「仅常用设备登录」时，只有它不被拦。
 * 随机号只在账号没开设备限制时能用。
 */
async function resolveDeviceId(
  ask: (prompt: LoginPrompt) => Promise<string>,
  knownDeviceId: string | undefined,
): Promise<string> {
  const preset = knownDeviceId || process.env.QB_DOUBAO_DEVICE_ID || '';
  if (preset) return preset;

  const fresh = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 15);
  const answer = await ask({
    id: 'device',
    label: '用哪个设备号登录',
    submitLabel: '下一步',
    options: [
      {
        value: 'from-client',
        label: '用豆包客户端的设备号（推荐）',
        hint: '账号开了「仅常用设备登录」时必须用这个，否则会被拦',
      },
      {
        value: fresh,
        label: '自动生成新设备号',
        hint: '只有账号没开设备限制时才能用',
      },
    ],
  });

  if (answer.trim() !== 'from-client') {
    log('用新生成的设备号（可能触发新设备验证）');
    return fresh;
  }

  const typed = (await ask({
    id: 'device-value',
    label: '豆包客户端的设备号',
    placeholder: '15 位数字。在 User Data/ahanet/tt_net_config.config 里 device_id&#*<数字>',
    inputType: 'text',
    submitLabel: '用这个',
  })).trim();
  if (/^\d{10,20}$/.test(typed)) return typed;
  log('设备号格式不对，退回新生成的');
  return fresh;
}

/** 让用户完成一次验证。前端渲染 iframe，用户点「我已完成验证」回填。 */
async function askChallenge(
  ask: (prompt: LoginPrompt) => Promise<string>,
  challenge: CaptchaChallenge,
): Promise<boolean> {
  const answer = await ask({
    id: `challenge-${challenge.ticket}`,
    label: `完成验证（${challengeName(challenge.subtype)}）`,
    submitLabel: '我已完成验证',
    challenge: {
      url: challenge.url,
      code: challenge.code,
      subtype: challenge.subtype,
      ticket: challenge.ticket,
    },
  });
  return answer.trim() !== '';
}

/** 让用户从账号列表里选一个，返回 sec_uid。 */
async function askAccount(
  ask: (prompt: LoginPrompt) => Promise<string>,
  accounts: SubAccount[],
): Promise<string> {
  const answer = (await ask({
    id: 'account',
    label: '选一个豆包账号登录',
    submitLabel: '登录',
    options: accounts.map((item) => ({
      value: item.secUid,
      label: item.name || item.secUid.slice(-8),
      subtitle: item.tenantName || (item.enterpriseType === 0 ? '个人账号' : ''),
      avatar: item.avatar || undefined,
    })),
  })).trim();

  const picked = accounts.find((item) => item.secUid === answer);
  if (!picked) throw new Error('没选中任何账号，登录已取消');
  return picked.secUid;
}

/**
 * 让用户完成 2046 的验证。返回票据（空串 = 用户放弃）。
 *
 * **不替用户挑方式**：上游给几种就列几种，每种下面写清「需要你手里有什么」。
 * 只有用户知道自己手边有没有另一台登录着豆包的设备。
 *
 * 三种方式的交互形态不同，所以第 ② 步要分开走：
 * - 短信：用户自己去手机发，回来点「已完成」，网关调一次 `upsms/verify`
 * - 扫码：网关给二维码图，用户扫完在手机上确认，回来点「已完成」，网关轮询状态
 * - 推送：网关推一条到已登录设备，用户把那台设备上看到的 6 位码**填进来**
 *
 * `ways` 只传递减：用户选过又放弃的方式不再重复出现，避免原地打转。
 */
async function askVerify(
  ask: (prompt: LoginPrompt) => Promise<string>,
  deviceId: string,
  ways: VerifyWay[],
  context: VerificationContext,
  jar: CookieJar,
  signal?: AbortSignal,
): Promise<string> {
  const usable = ways.filter((item) => canVerifyHere(item.way));
  if (usable.length === 0) throw noVerifiableWayError(buildRiskInfo(ways, context));

  // ① 选方式。全部列出来，做不了的也列（用户才知道上游要什么），只是灰掉。
  log(
    `给用户选验证方式：可选=${usable.map((w) => w.way).join('/')} ` +
      `不可选=${ways.filter((w) => !canVerifyHere(w.way)).map((w) => w.way).join('/') || '(无)'}`,
  );
  const picked = (
    await ask({
      id: 'verify-way',
      label: '豆包要求二次验证，选一种方式',
      submitLabel: '下一步',
      options: ways.map((item) => ({
        value: item.way,
        label: item.label,
        hint: item.hint,
        // 做不了的也显示，只是灰掉——隐藏会让用户以为网关漏了一种方式。
        disabled: !canVerifyHere(item.way),
      })),
    })
  ).trim();

  const way = usable.find((item) => item.way === picked);
  if (!way) {
    log(`用户选了网关做不了的方式（${picked || '空'}），中止`);
    throw new Error('这个验证方式网关做不了，换一个，或取消后用「导入 cookie」');
  }

  log(`用户选了 way=${way.way}`);
  let handle = await beginVerify(deviceId, context, way, jar, signal);

  // ② 用户去做。推送要填码，短信要显示三段信息，扫码要显示图。
  //
  // 扫码用一个循环：二维码过期不是失败，换一张就能继续，别让用户重新走一遍登录。
  for (;;) {
    const needsOtp = way.way === 'push_verify';
    const isQr = way.way === 'qr_code_verify';
    const answer = (
      await ask({
        id: `verify-${way.way}`,
        label: handle.instruction,
        submitLabel: needsOtp ? '提交验证码' : '我已完成，继续登录',
        qrCode: handle.qrCode,
        ...(needsOtp ? { otpLength: 6 } : {}),
        // 短信验证的三个要素要结构化传下去，界面才排得清楚（挤成一句话用户会抄错）。
        ...(way.way === 'mobile_up_sms_verify'
          ? {
              sms: {
                channelMobile: way.channelMobile || '',
                content: way.smsContent || '',
                mobile: way.mobile || '',
              },
            }
          : {}),
        options: needsOtp
          ? [{ value: 'resend', label: '重新推送', hint: '没收到通知就点这个' }]
          : isQr
            ? [
                { value: 'done', label: '我已完成，继续登录', hint: '扫完在手机上确认后点这个' },
                { value: 'refresh-qr', label: '刷新二维码', hint: '码过期了就点这个换一张' },
                { value: 'skip', label: '换一种方式', hint: '回到上一步重新选' },
              ]
            : [
                { value: 'done', label: '我已完成，继续登录', hint: '点这个之后网关会去上游确认' },
                { value: 'skip', label: '换一种方式', hint: '回到上一步重新选' },
              ],
      })
    ).trim();

    if (answer === '') {
      log(`用户在 ${way.way} 这步放弃，返回空票据`);
      return '';
    }

    if (answer === 'skip') {
      log(`用户放弃 ${way.way}，换一种方式`);
      return askVerify(
        ask,
        deviceId,
        ways.filter((item) => item.way !== way.way),
        context,
        jar,
        signal,
      );
    }

    if (answer === 'resend') {
      log('用户要求重新推送，回到选择');
      return askVerify(ask, deviceId, ways, context, jar, signal);
    }

    // 用户主动刷新二维码：作废旧码、换新码，重新显示同一张卡片。
    if (answer === 'refresh-qr') {
      log('用户要求刷新二维码');
      await expireQrCode(deviceId, context, handle, jar, signal);
      const fresh = await refreshQrCode(deviceId, jar, signal);
      handle = { ...handle, qrCode: fresh.image, state: { token: fresh.token } };
      continue;
    }

    if (needsOtp) log(`用户提交了推送验证码（${answer.length} 位）`);

    try {
      return await confirmVerify(deviceId, context, way, handle, jar, {
        signal,
        ...(needsOtp ? { pushCode: answer } : {}),
      });
    } catch (error: any) {
      // 二维码过期不是失败：换一张，让用户接着扫。
      if (isQr && error?.qrExpired) {
        log('二维码过期，自动换一张');
        await expireQrCode(deviceId, context, handle, jar, signal);
        const fresh = await refreshQrCode(deviceId, jar, signal);
        handle = { ...handle, qrCode: fresh.image, state: { token: fresh.token } };
        continue;
      }

      log(`确认验证失败 way=${way.way}：${error?.message || error}`);
      // 推送码填错是最常见的一次性错误：直接再问一次，别让用户从头登录。
      if (needsOtp && error instanceof UpstreamError) {
        const retry = (
          await ask({
            id: `verify-${way.way}-retry`,
            label: error.message,
            submitLabel: '提交验证码',
            otpLength: 6,
          })
        ).trim();
        if (retry === '') {
          log('用户放弃重填验证码');
          return '';
        }
        log(`用户重填了推送码（${retry.length} 位），再确认一次`);
        return confirmVerify(deviceId, context, way, handle, jar, { signal, pushCode: retry });
      }
      throw error;
    }
  }
}
/** 把 `verify_ways` 包成 `RiskControlInfo`，给 `noVerifiableWayError` 用。 */
function buildRiskInfo(ways: VerifyWay[], context: VerificationContext) {
  return {
    code: 2046,
    message: '上游只给了要跳第三方授权页的验证方式',
    diversion: 'mfa',
    deviceBound: true,
    retryAt: Date.now() + 10 * 60 * 1000,
    challenge: null,
    verifyWays: ways,
    verification: context,
  };
}
