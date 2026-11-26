// 2046 的验证方式：让用户在网关界面上完成验证，不再依赖官方客户端。
//
// 依据是官方这三个页面的实现（懒加载 chunk，2026-11-26 逆向）：
//   9888  app-mfa_mobile-up-sms-verify/page  → verifyUpSms({verify_ticket, encrypt_uid, std_verify_way, verify_way})
//   6193  app-mfa_push-verify/page          → sendPush({verify_way, encrypt_uid, scene, last_token})
//                                             → checkPushCode({token, push_code})  用户手输验证码
//   4870  app-mfa_qr-code-verify/page       → getQrCode({encrypt_uid, scene, verify_scene})
//                                             → validateByQrCode({token, encrypt_uid}) 3 秒轮询
//
// **客户端那层 JSBridge 只用来通知宿主 App「验证完了、关窗口」**，
// 真正的请求都是普通 passport 接口，没签名、没原生依赖——所以网关能照着做。
// 三种方式都能纯 HTTP 做完；`oauth_douyin_verify` 要跳抖音授权页，做不到。
//
// 分两段而不是一次阻塞：推送和扫码都要用户在**另一台设备**上操作完才回得来，
// 而 `onPrompt` 是「问一句等回答」的形状，没法在里面转圈轮询。

import { UpstreamError } from '../../shared/upstream-error.ts';
import { errorCodeOf, loginLog, messageOf, postForm } from './passport.ts';
import type { CookieJar } from './passport.ts';
import type { VerificationContext, VerifyWay } from './risk-control.ts';

const UPSMS_VERIFY = '/passport/upsms/verify/';
const SEND_PUSH = '/passport/web/send_push/';
const CHECK_PUSH_CODE = '/passport/device/check_push_code/';
const GET_QRCODE = '/passport/web/get_qrcode/';
const VALIDATE_BY_QRCODE = '/passport/web/validate_by_qrcode/';
const EXPIRE_QRCODE = '/passport/web/expire_qrcode/';

/** 二维码状态。官方枚举 `86191.js` 的 `Xu`。`new` 表示还没人扫，继续等。 */
const QR_SCANNED = 'scanned';
const QR_CONFIRMED = 'confirmed';
const QR_REFUSED = 'refused';
const QR_EXPIRED = 'expired';

/** 扫码轮询间隔，官方是 3 秒。 */
const QR_POLL_MS = 3_000;
/** 单次验证最多等多久。再长用户已经走开了。 */
const VERIFY_TIMEOUT_MS = 5 * 60_000;

/** 一条验证方式能不能由网关完成。`oauth_douyin_verify` 要抖音授权，做不了。 */
export function canVerifyHere(way: string): boolean {
  return way === 'mobile_up_sms_verify' || way === 'push_verify' || way === 'qr_code_verify';
}

/** 一条验证方式开始后需要界面展示的东西。 */
export interface VerifyHandle {
  /** 要用户做的事（一句话，界面直接显示）。 */
  instruction: string;
  /** 二维码地址（只有 `qr_code_verify` 有）。可能是 data URI，也可能是远程图片。 */
  qrCode?: string;
  /** 内部状态，交给 `confirmVerify()`。 */
  state: Record<string, string>;
}

/**
 * 开始验证，拿到界面要显示的东西。**这一步不发任何短信给用户**——
 * `mobile_up_sms_verify` 是让用户自己用手机发短信到上游给的号码。
 */
export async function beginVerify(
  deviceId: string,
  context: VerificationContext,
  way: VerifyWay,
  jar: CookieJar,
  signal?: AbortSignal,
): Promise<VerifyHandle> {
  if (way.way === 'mobile_up_sms_verify') {
    if (!way.channelMobile || !way.smsContent) {
      throw new UpstreamError(429, '上游给了短信验证方式，但没说发到哪个号码。换扫码或推送。', {
        code: 'doubao_verify_failed',
      });
    }
    loginLog(
      `短信验证：要用户发「${way.smsContent}」到 ${way.channelMobile}（手机 ${way.mobile || '未知'}）`,
    );
    // 具体的号码 / 正文在 `sms` 字段里，卡片会分段显示，所以这里只当标题用，
    // 别把三段重复说一遍——用户要在两处对照，反而容易抄错。
    return {
      instruction: '用手机发一条短信完成验证',
      state: {},
    };
  }

  if (way.way === 'push_verify') {
    // 官方：sendPush → 拿 token → 页面显示 OTP 输入框，用户把已登录设备上看到的
    // 6 位码填进来 → checkPushCode。**不是轮询**，别再去调 check_push_result。
    const sent = await postForm(
      deviceId,
      SEND_PUSH,
      {
        verify_way: 'push_verify',
        encrypt_uid: context.encryptUid,
        scene: String(context.verifyScene || ''),
        action: '1',
      },
      jar,
      { signal },
    );
    const token = String(sent.doc?.data?.token || '');
    if (!token) {
      throw new UpstreamError(
        429,
        `推送验证发不出去（上游 ${errorCodeOf(sent.doc)}：${messageOf(sent.doc) || '没给推送 token'}）。` +
          '换「发送短信验证码」试试。',
        { code: 'doubao_verify_failed' },
      );
    }
    const names = Array.isArray(sent.doc?.data?.device_names) ? sent.doc.data.device_names.join('、') : '';
    loginLog(`推送验证：已推给设备[${names || '未知'}] token=${token.slice(0, 8)}…，等用户抄验证码`);
    return {
      instruction:
        '已给已登录豆包的设备推送了确认请求' +
        (names ? `（${names}）` : '') +
        '。在那台设备上打开通知，把显示的验证码填到下面。',
      state: { token },
    };
  }

  if (way.way === 'qr_code_verify') {
    // 实测：`get_qrcode` 要 `next`，**给 `encrypt_uid` 反而回「缺少参数」**。
    // 官方 4870.js 里那串 `{encrypt_uid, scene, verify_scene}` 是组件入参名，
    // 到了 SDK 层只把 `next` 传给上游——别照文档抄。
    const got = await getQrCode(deviceId, jar, signal);
    if (!got.token || !got.image) {
      throw new UpstreamError(
        429,
        `拿不到扫码用的二维码（上游 ${got.code}：${got.message || '没给 qrcode'}）。` +
          '换「发送短信验证码」试试。',
        { code: 'doubao_verify_failed' },
      );
    }
    loginLog(
      `扫码验证：二维码已生成 token=${got.token.slice(0, 8)}… ` +
        `图片 ${got.image.length} 字符，等用户扫`,
    );
    // 二维码卡片自己带说明了，这里只当标题，别重复。
    return {
      instruction: '用已登录豆包的手机扫码完成验证',
      qrCode: got.image,
      state: { token: got.token },
    };
  }

  throw new UpstreamError(429, '这个验证方式网关做不了。', { code: 'doubao_verify_failed' });
}

/**
 * 取一张二维码。
 *
 * **`qrcode` 才是图片**（实测是完整的 `data:image/png;base64,…`，2619 字节 PNG）。
 * `qrcode_index_url` 名字像图片，实际是 `scan-login` 那个 HTML 页面——
 * 塞进 `<img src>` 显示不出来，别优先用它。
 */
async function getQrCode(
  deviceId: string,
  jar: CookieJar,
  signal?: AbortSignal,
): Promise<{ token: string; image: string; code: number; message: string }> {
  const got = await postForm(
    deviceId,
    GET_QRCODE,
    { next: 'https://www.doubao.com/', need_logo: 'false', need_short_url: 'false', is_new_login: '1' },
    jar,
    { signal, method: 'GET', formInQuery: true },
  );
  const data = got.doc?.data || {};
  const raw = String(data.qrcode || '');
  let image = '';
  if (raw.startsWith('data:')) {
    image = raw;
  } else if (raw && !raw.startsWith('http')) {
    // 上游通常带 `data:image/png;base64,` 前缀，但不带时自己补。
    image = `data:image/png;base64,${raw}`;
  }
  return {
    token: String(data.token || ''),
    image,
    code: errorCodeOf(got.doc),
    message: messageOf(got.doc),
  };
}

/**
 * 用户说「我做完了」之后，向上游确认并拿到 `ticket`。
 *
 * 推送要靠用户填进来的验证码（`pushCode`），扫码要轮询状态，
 * 短信是一次性 POST——三种形状完全不同，所以拆成三条分支。
 */
export async function confirmVerify(
  deviceId: string,
  context: VerificationContext,
  way: VerifyWay,
  handle: VerifyHandle,
  jar: CookieJar,
  options: { signal?: AbortSignal; timeoutMs?: number; pushCode?: string } = {},
): Promise<string> {
  if (way.way === 'mobile_up_sms_verify') {
    const reply = await postForm(
      deviceId,
      UPSMS_VERIFY,
      {
        verify_ticket: context.verifyTicket,
        encrypt_uid: context.encryptUid,
        std_verify_way: way.way,
        verify_way: way.way,
      },
      jar,
      { signal: options.signal },
    );
    const ticket = String(reply.doc?.data?.ticket || '');
    if (errorCodeOf(reply.doc) !== 0 || !ticket) {
      throw new UpstreamError(
        429,
        `短信验证没通过（上游 ${errorCodeOf(reply.doc)}：${messageOf(reply.doc) || '没收到那条短信'}）。` +
          `确认内容是「${way.smsContent}」、发到了 ${way.channelMobile}，等一两分钟再试。`,
        { code: 'doubao_verify_failed' },
      );
    }
    loginLog(`upsms 验证通过 ticket=${ticket.slice(0, 12)}…`);
    return ticket;
  }

  if (way.way === 'push_verify') {
    const code = String(options.pushCode || '').trim();
    if (!code) throw new UpstreamError(429, '推送验证要填设备上显示的验证码。', { code: 'doubao_verify_failed' });
    const reply = await postForm(
      deviceId,
      CHECK_PUSH_CODE,
      { token: handle.state.token || '', push_code: code },
      jar,
      { signal: options.signal },
    );
    const ticket = String(reply.doc?.data?.ticket || '');
    if (errorCodeOf(reply.doc) !== 0 || !ticket) {
      throw new UpstreamError(
        429,
        `推送验证码不对（上游 ${errorCodeOf(reply.doc)}：${messageOf(reply.doc) || '验证失败'}）。` +
          '重新看一下设备上的那 6 位数字。',
        { code: 'doubao_verify_failed' },
      );
    }
    loginLog(`push 验证通过 ticket=${ticket.slice(0, 12)}…`);
    return ticket;
  }

  if (way.way === 'qr_code_verify') {
    return pollQrCode(deviceId, context, handle, jar, options);
  }

  throw new UpstreamError(429, '这个验证方式网关做不了。', { code: 'doubao_verify_failed' });
}

/**
 * 扫码：3 秒轮询一次 `validate_by_qrcode`，按官方那套状态机走。
 *
 * **二维码过期不偷偷换码**：官方是前端管的（过期 → 显示「已失效，点刷新」→ 用户点了
 * 才重新 `get_qrcode`），我们也照这个来。原因是「网关悄悄换了一张新图、但界面上还是
 * 旧图」——用户对着旧二维码扫，永远扫不进去，而他不知道图已经变了。
 *
 * 所以这里过期就抛一个带 `qrExpired` 标记的错误，前端据此显示刷新按钮；
 * 用户点刷新时提交 `refresh-qr`，由 `refreshQrCode()` 换码。
 */
async function pollQrCode(
  deviceId: string,
  context: VerificationContext,
  handle: VerifyHandle,
  jar: CookieJar,
  options: { signal?: AbortSignal; timeoutMs?: number },
): Promise<string> {
  const deadline = Date.now() + (options.timeoutMs ?? VERIFY_TIMEOUT_MS);
  const token = handle.state.token || '';

  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new Error('登录已取消');

    const reply = await postForm(
      deviceId,
      VALIDATE_BY_QRCODE,
      { token, encrypt_uid: context.encryptUid },
      jar,
      { signal: options.signal },
    );
    const status = String(reply.doc?.data?.status || '');
    const ticket = String(reply.doc?.data?.ticket || '');

    if (status === QR_CONFIRMED && ticket) {
      loginLog(`扫码验证通过 ticket=${ticket.slice(0, 12)}…`);
      return ticket;
    }
    if (status === QR_SCANNED) {
      loginLog('二维码已被扫描，等手机确认');
    }

    if (status === QR_REFUSED) {
      throw new UpstreamError(429, '手机上拒绝了这次验证。重新发起登录，或换「发送短信验证码」。', {
        code: 'doubao_verify_failed',
      });
    }

    if (status === QR_EXPIRED) {
      // 把「换码」的决定权交给用户：界面显示刷新按钮，点了才换。
      loginLog('二维码已过期，等用户点刷新');
      throw new UpstreamError(429, '二维码过期了。点「刷新二维码」换一张，再扫。', {
        code: 'doubao_verify_failed',
        qrExpired: true,
      });
    }

    await new Promise((resolve) => setTimeout(resolve, QR_POLL_MS));
  }

  throw new UpstreamError(
    429,
    `扫码验证超时（${Math.round(VERIFY_TIMEOUT_MS / 60000)} 分钟）。重新发起登录，或换「发送短信验证码」。`,
    { code: 'doubao_verify_failed' },
  );
}

/** 换一张新二维码。用户点「刷新二维码」时调。 */
export async function refreshQrCode(
  deviceId: string,
  jar: CookieJar,
  signal?: AbortSignal,
): Promise<{ token: string; image: string }> {
  const got = await getQrCode(deviceId, jar, signal);
  if (!got.token || !got.image) {
    throw new UpstreamError(
      429,
      `换二维码失败（上游 ${got.code}：${got.message || '没给 qrcode'}）。换「发送短信验证码」试试。`,
      { code: 'doubao_verify_failed' },
    );
  }
  loginLog(`已换新二维码 token=${got.token.slice(0, 8)}…`);
  return { token: got.token, image: got.image };
}

/** 作废当前二维码。用户点「刷新」或换验证方式时调，别让上游留一张活着的码。 */
export async function expireQrCode(
  deviceId: string,
  context: VerificationContext,
  handle: VerifyHandle,
  jar: CookieJar,
  signal?: AbortSignal,
): Promise<void> {
  const token = handle.state.token || '';
  if (!token) return;
  try {
    await postForm(deviceId, EXPIRE_QRCODE, { token, encrypt_uid: context.encryptUid }, jar, { signal });
  } catch {
    // 作废失败不影响主流程：那张码自己会过期。
  }
}

/**
 * 验证通过后重放原请求。**不做这一步等于白验证。**
 *
 * SDK 的做法（passport SDK chunk `6151` 的 `processPlugin`）：
 * ```js
 * const s = this.getResendData(n.data, { ...e.biz_params, ...r.bizParams });
 * return this.request({ ...n, params: { ...n.params, isResend: true }, data: s });
 * ```
 * `biz_params` 里是 `sec_uid` / `sms_code_key` / `passport_mfa_retry_tag`，
 * 缺了它上游会再回一次 2046。
 */
export async function finishVerification(
  deviceId: string,
  context: VerificationContext,
  ticket: string,
  jar: CookieJar,
  signal?: AbortSignal,
): Promise<any> {
  const form: Record<string, string> = { ...context.resendForm, ...context.bizParams };
  if (ticket) form.verify_ticket = ticket;
  const reply = await postForm(deviceId, context.resendPath, form, jar, {
    signal,
    query: { isResend: '1' },
  });
  loginLog(`重放原请求 ${context.resendPath} → code=${errorCodeOf(reply.doc)}`);
  return reply.doc;
}
