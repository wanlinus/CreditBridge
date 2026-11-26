// 豆包 passport 的 HTTP 底座：cookie 罐、query/header 构造、请求发送。
//
// 单独拆出来的理由：登录流程（`login.ts`）本来 747 行，HTTP 细节、编解码、
// 日志脱敏、三条登录路径全挤在一起。风控排查期间每次改协议都要在一坨里找位置。
//
// **cookie 罐是这里最要紧的东西**：上游在「校验验证码」那步会下发
// `passport_mfa_token` / `d_ticket`，选号必须带着，否则会话不完整。
// 早先每一步都新建请求、从不收 `Set-Cookie`，为此卡了两天。

import { PASSPORT_BASE, userAgent } from './auth.ts';

/** 登录用的 aid（`DESKTOP_DOUBAO_WORK_APP_ID`，豆包办公桌面版）。 */
export const LOGIN_AID = '1044603';

/**
 * `ttwid/register` 用的 aid，**和登录的 aid 不同**。
 * 它是 `doubao_pc` 的渠道号（见 `zr.c78deb6e90.js` 的 aid 表），
 * 用 `LOGIN_AID` 会回 `parse params fail`。
 */
const TTWID_AID = 582478;

/** 短信验证码的 type。抓包里 `type=3731` 解出来就是这个值。 */
export const SMS_TYPE = '24';

export interface PassportReply {
  doc: any;
  text: string;
  status: number;
}

/** 日志出口。由通道 `configure()` 注入。 */
let logSink: any = null;
export function setLoginLogger(fn: any) {
  logSink = fn;
}
/** 打一行登录日志。`login.ts` 也用它，保证两边前缀一致、容器日志里能串起来。 */
export function loginLog(...args: unknown[]): void {
  logSink?.(`[doubao-login] ${args.join(' ')}`);
}

/**
 * 登录会话的 cookie 罐。
 *
 * 整个登录（ttwid → 发码 → 校验 → 选号）共用一份，每步从 `Set-Cookie` 收、
 * 下一步自动带上。空值视为删除指令。
 */
export class CookieJar {
  private readonly cookies: Record<string, string> = {};

  absorb(list: string[]): void {
    for (const raw of list) {
      // 一行可能塞多条（逗号分隔），先按 `, name=` 切开。
      for (const piece of raw.split(/,(?=\s*[A-Za-z0-9_-]+=)/)) {
        const first = piece.split(';')[0].trim();
        const at = first.indexOf('=');
        if (at <= 0) continue;
        const name = first.slice(0, at);
        const value = first.slice(at + 1);
        // 空值是删除指令（`Max-Age=0`），别让旧值继续带出去。
        if (value === '') delete this.cookies[name];
        else this.cookies[name] = value;
      }
    }
  }

  header(): string {
    return Object.entries(this.cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  /** 当前罐里有哪些 cookie 名（日志用，不含值）。 */
  names(): string {
    return Object.keys(this.cookies).join(',') || '(空)';
  }

  get(name: string): string | undefined {
    return this.cookies[name];
  }

  all(): Record<string, string> {
    return { ...this.cookies };
  }
}

/** passport 接口的 query。实测去掉 `sign` / `qs` / `a_bogus` / `csrf` 仍能走到业务层。 */
function passportQuery(deviceId: string): string {
  return new URLSearchParams({
    passport_jssdk_version: '4.4.6',
    passport_jssdk_type: 'normal',
    is_from_ttaccountsdk: '1',
    aid: LOGIN_AID,
    language: 'zh',
    account_app_language: 'zh-CN',
    account_sdk_source: 'web',
    device_platform: 'desktop',
    device_id: deviceId,
    os_type: '1',
    terminal_type: '1',
    version_code: '2.38.7',
  }).toString();
}

function loginHeaders(deviceId: string, cookie = ''): Record<string, string> {
  // `x-tt-multi-sids` 从 cookie 里提：客户端成功选号那次是有的。
  // 它告诉上游「这个会话能操作哪些账号」，缺了可能被判成不完整会话。
  const multiSids = /(?:^|;\s*)multi_sids=([^;]+)/.exec(cookie)?.[1] || '';
  // **CSRF token 必须随请求带**，否则敏感接口回 `2035 CSRF_TOKEN_ERROR`（文案写「非法请求」）。
  // 官方 SDK 把它配在 axios 的 `xsrfCookieName: 'passport_csrf_token'` /
  // `xsrfHeaderName: 'x-tt-passport-csrf-token'`，等于每次请求自动加这个头。
  // 2026-11-26 漏了它，`send_push` 一直 2035；发码和选号不校验 CSRF，所以只有推送暴露出来。
  const csrf =
    /(?:^|;\s*)passport_csrf_token=([^;]*)/.exec(cookie)?.[1] ||
    /(?:^|;\s*)passport_csrf_token_default=([^;]*)/.exec(cookie)?.[1] ||
    '';
  return {
    'User-Agent': userAgent(),
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/x-www-form-urlencoded',
    Referer: 'https://www.doubao.com/',
    Origin: 'https://www.doubao.com',
    fp: `verify_${deviceId}`,
    verifyFp: `verify_${deviceId}`,
    ...(multiSids ? { 'x-tt-multi-sids': multiSids } : {}),
    ...(csrf ? { 'x-tt-passport-csrf-token': csrf } : {}),
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

/**
 * 注册 `ttwid` 设备标识。**登录前必须先做**——客户端页面一加载就有它，
 * passport 请求全程带着；缺了它服务端会认为会话不完整。
 *
 * 三个坑（照抓包对齐的）：
 * 1. `aid` 用 582478，不是登录的 1044603
 * 2. `Content-Type` 写 `form-urlencoded`，body 却是 JSON 字符串
 * 3. 域名是 `www.doubao.com`，`accounts.doubao.com` 返回 HTML
 */
export async function registerTtwid(jar: CookieJar, signal?: AbortSignal): Promise<void> {
  const body = JSON.stringify({
    aid: TTWID_AID,
    service: 'www.doubao.com',
    host: 'https://www.doubao.com',
    unionHost: '',
    union: false,
    needFid: false,
    fid: '',
  });
  const timeout = AbortSignal.timeout(15_000);
  const response = await fetch('https://www.doubao.com/ttwid/register/', {
    method: 'POST',
    headers: {
      'User-Agent': userAgent(),
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: 'https://www.doubao.com/',
      Origin: 'https://www.doubao.com',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    body,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const setCookies = response.headers.getSetCookie?.() ?? [];
  jar.absorb(setCookies);
  const text = await response.text();
  loginLog(`→ /ttwid/register/ HTTP ${response.status} set-cookie=[${setCookies.map((c) => c.split('=')[0]).join(',')}]`);
  loginLog(`← /ttwid/register/ ${text.slice(0, 120)}`);
}

/**
 * 发一个 passport 表单请求。每步都带上罐里的 cookie，并把响应的 `Set-Cookie` 收进罐。
 *
 * **业务错误码（非 0）时打印完整响应 JSON**，不挑字段——2026-11-26 因为只打
 * `captcha` / `desc_url`，漏掉 `verify_center_decision_conf`，误判成「上游不出题」查了一整天。
 */
export async function postForm(
  deviceId: string,
  pathname: string,
  form: Record<string, string>,
  jar: CookieJar,
  options: {
    signal?: AbortSignal;
    method?: 'GET' | 'POST';
    /** 额外的 query 参数。重放原请求时要带 `isResend=1`（SDK 的 `processPlugin`）。 */
    query?: Record<string, string>;
    /** GET 时把 `form` 拼进 query，而不是丢进 body。 */
    formInQuery?: boolean;
  } = {},
): Promise<PassportReply> {
  const method = options.method ?? 'POST';
  const base = new URLSearchParams(passportQuery(deviceId));
  for (const [key, value] of Object.entries(options.query ?? {})) base.set(key, value);
  const getForm = method === 'GET' || options.formInQuery;
  if (getForm) {
    for (const [key, value] of Object.entries(form)) base.set(key, value);
  }

  const url = `${PASSPORT_BASE}${pathname}?${base.toString()}`;
  const timeout = AbortSignal.timeout(25_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  const init: RequestInit = {
    method,
    headers: loginHeaders(deviceId, jar.header()),
    signal,
  };
  if (method === 'POST') {
    init.body = new URLSearchParams(form).toString();
  }

  const response = await fetch(url, init);
  const text = await response.text();
  let doc: any = null;
  try {
    doc = JSON.parse(text);
  } catch {
    /* 上游偶尔回 HTML */
  }
  const setCookies = response.headers.getSetCookie?.() ?? [];
  jar.absorb(setCookies);

  loginLog(
    `→ ${pathname} HTTP ${response.status} ` +
      `body=${redactForm(form)} ` +
      `${getForm ? 'query' : ''} ` +
      `set-cookie=[${setCookies.map((c) => c.split('=')[0]).join(',')}]`,
  );
  loginLog(`← ${pathname} ${summarizeReply(doc, text)}`);

  return { doc, text, status: response.status };
}

/** 表单脱敏：保留结构，敏感值只留头尾。 */
function redactForm(form: Record<string, string>): string {
  const SENSITIVE = /mobile|ticket|code|key|sec_uid|password/i;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(form)) {
    const value = String(v);
    if (value === '') {
      parts.push(`${k}=`);
    } else if (SENSITIVE.test(k)) {
      parts.push(`${k}=${value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}(${value.length})` : '***'}`);
    } else {
      parts.push(`${k}=${value}`);
    }
  }
  return parts.join('&');
}

/** 响应摘要。业务错误码时带完整 JSON。 */
function summarizeReply(doc: any, text: string): string {
  if (!doc) return `非 JSON（${text.length} 字节）：${text.slice(0, 200)}`;
  const data = doc?.data ?? doc;
  const code = data?.error_code ?? doc?.code;
  const bits: string[] = [`code=${code ?? '-'}`];

  if (data?.description) bits.push(`desc="${String(data.description).slice(0, 60)}"`);
  if (data?.account_flow) bits.push(`account_flow=${data.account_flow}`);
  if (data?.exist_doubao_account !== undefined) bits.push(`exist=${data.exist_doubao_account}`);
  if (data?.mobile_ticket) bits.push(`ticket=${String(data.mobile_ticket).slice(-8)}`);
  if (data?.sms_code_key) bits.push(`sms_key=${String(data.sms_code_key).slice(0, 8)}…`);
  if (data?.user_id_str || data?.user_id) bits.push(`uid=${data.user_id_str || data.user_id}`);
  if (data?.common_params?.ies_safety_diversion_tag !== undefined) {
    bits.push(`diversion=${data.common_params.ies_safety_diversion_tag || '(空)'}`);
  }
  if (Array.isArray(data?.sub_account)) {
    bits.push(
      `sub_account=[${data.sub_account.map((a: any) => `${a.name}(企业${a.passport_enterprise_user_type ?? 0})`).join(',')}]`,
    );
  }

  // 业务错误码（非 0）全量打印，不挑字段。这是唯一能保证不漏线索的做法。
  const numeric = Number(code);
  if (Number.isFinite(numeric) && numeric !== 0) {
    bits.push(`完整响应=${JSON.stringify(doc).slice(0, 2000)}`);
  }

  return bits.join(' ');
}

/** 从上游响应里取错误码。两种情况：`{data:{error_code}}` 或 `{code}`。 */
export function errorCodeOf(doc: any): number {
  const raw = doc?.data?.error_code ?? doc?.error_code ?? doc?.code;
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

export function messageOf(doc: any): string {
  return String(doc?.data?.description || doc?.message || doc?.msg || '').trim();
}
