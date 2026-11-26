// 守护：接口路径写错不报错、只让用户白做一遍——可做性判定、接口路径、字段名都要钉死。
import { check, section, done } from './_helpers.mjs';
import { readFileSync } from 'node:fs';

const { canVerifyHere } = await import('../src/channels/doubao/verify-ways.ts');
const { VERIFY_WAY_HINTS, riskControlOf } = await import('../src/channels/doubao/risk-control.ts');

section('1. 哪些验证方式网关能做');
for (const [way, can] of [
  ['mobile_up_sms_verify', true], ['qr_code_verify', true], ['push_verify', true],
  ['oauth_douyin_verify', false], ['mobile_auth_face_verify', false],
  ['pwd_verify', false], ['', false],
]) check(way || '空串', canVerifyHere(way), can);

section('2. 每种方式都有「需要你手里有什么」的说明');
// 用户选方式的依据是这句话，不是方式名；做不了的要说清做不了
for (const way of ['mobile_up_sms_verify', 'qr_code_verify', 'push_verify', 'oauth_douyin_verify']) {
  check(`${way} 有说明`, typeof VERIFY_WAY_HINTS[way] === 'string' && VERIFY_WAY_HINTS[way].length > 5, true);
}
check('短信说明提到手机', VERIFY_WAY_HINTS.mobile_up_sms_verify.includes('手机'), true);
check('扫码说明提到另一台设备', VERIFY_WAY_HINTS.qr_code_verify.includes('另一台'), true);
check('推送说明提到另一台设备', VERIFY_WAY_HINTS.push_verify.includes('另一台'), true);
check('抖音说明写明网关做不了', VERIFY_WAY_HINTS.oauth_douyin_verify.includes('做不了'), true);

section('3. 响应里带出说明');
const real2046 = {
  data: {
    error_code: 2046,
    verify_ways: [
      { verify_way: 'qr_code_verify' },
      { verify_way: 'mobile_up_sms_verify', channel_mobile: '10691859839103', sms_content: 'YZ', mobile: '155******33' },
      { verify_way: 'push_verify' },
      { verify_way: 'oauth_douyin_verify', platform_screen_name: '**乐' },
    ],
  },
};
const info = riskControlOf(real2046, 1000);
check('四种方式都带出 hint', info.verifyWays.every((w) => w.hint.length > 0), true);
check('短信的 hint 指向手机', info.verifyWays[1].hint.includes('手机'), true);
const unknown = riskControlOf({ data: { error_code: 2046, verify_ways: [{ verify_way: 'brand_new_way' }] } }, 1000);
check('未知方式 hint 为空串', unknown.verifyWays[0].hint, '');
check('未知方式 label 退回原文', unknown.verifyWays[0].label, 'brand_new_way');

section('4. 三种方式对应的接口（逆向自官方页面，钉死别改错）');
const src = readFileSync(new URL('../src/channels/doubao/verify-ways.ts', import.meta.url), 'utf8');
const paths = [...src.matchAll(/const\s+[A-Z_]+\s*=\s*'([^']*)'/g)].map((m) => m[1]);
check('短信接口路径', paths.includes('/passport/upsms/verify/'), true);
check('推送接口路径', paths.includes('/passport/web/send_push/'), true);
// check_push_result 是「一次性登录」用的，不是 MFA 推送验证
check('推送确认用 check_push_code', paths.includes('/passport/device/check_push_code/'), true);
check('推送确认不用 check_push_result', paths.some((p) => p.includes('check_push_result')), false);
check('扫码取码接口', paths.includes('/passport/web/get_qrcode/'), true);
// check_qrconnect 是扫码登录用的，MFA 扫码验证走 validate_by_qrcode
check('扫码验证用 validate_by_qrcode', paths.includes('/passport/web/validate_by_qrcode/'), true);
check('扫码验证不用 check_qrconnect', paths.some((p) => p.includes('check_qrconnect')), false);

section('5. 状态机用官方枚举值（86191.js 的 Xu）');
for (const value of ['scanned', 'confirmed', 'refused', 'expired']) {
  check(`状态 ${value}`, src.includes(`'${value}'`), true);
}

section('6. 二维码图片取自 qrcode 字段（不是 qrcode_index_url）');
// qrcode_index_url 是 scan-login 的 HTML 页面（40KB，<!DOCTYPE），塞 img 白板一片
check('优先用 qrcode 字段', /String\(data\.qrcode\s*\|\|\s*''\)/.test(src), true);
check('不拿 qrcode_index_url 当图片', src.includes('qrcode_index_url ||'), false);
check('注释里记了 qrcode_index_url 是 HTML', src.includes('HTML'), true);

section('7. 每一步都要有日志（跑了没日志 = 白查）');
for (const [what, pattern] of [
  ['发短信前记录', /短信验证：要用户发/],
  ['推送发出后记录', /推送验证：已推给设备/],
  ['二维码生成后记录', /扫码验证：二维码已生成/],
  ['扫码被扫到', /二维码已被扫描/],
  ['二维码过期', /二维码已过期/],
  ['换新二维码', /已换新二维码/],
  ['短信验证通过', /upsms 验证通过/],
  ['推送验证通过', /push 验证通过/],
  ['扫码验证通过', /扫码验证通过/],
  ['重放原请求', /重放原请求/],
]) check(what, pattern.test(src), true);

section('8. CSRF token 必须随请求带');
// 2035 = CSRF_TOKEN_ERROR；只有推送校验，发码/选号不校验——这类「只有某接口才炸」最费时间
const passportSrc = readFileSync(new URL('../src/channels/doubao/passport.ts', import.meta.url), 'utf8');
check('带 x-tt-passport-csrf-token 头', passportSrc.includes('x-tt-passport-csrf-token'), true);
check('从 passport_csrf_token 取', passportSrc.includes('passport_csrf_token'), true);
check('回退到 passport_csrf_token_default', passportSrc.includes('passport_csrf_token_default'), true);

section('9. 二维码过期可以刷新（不自动换）');
// 后端偷偷换码会让用户对着旧图扫，永远扫不进去
check('有独立的 refreshQrCode', /export async function refreshQrCode/.test(src), true);
check('有过期作废接口 expire_qrcode', src.includes("'/passport/web/expire_qrcode/'"), true);
check('过期抛 qrExpired 标记', /qrExpired: true/.test(src), true);
const pollPart = src.slice(src.indexOf('async function pollQrCode'), src.indexOf('export async function refreshQrCode'));
check('pollQrCode 里不再自动换码', /refreshes \+= 1/.test(pollPart), false);
check('pollQrCode 用完就抛过期信号', /status === QR_EXPIRED/.test(pollPart), true);

const errSrc = readFileSync(new URL('../src/shared/upstream-error.ts', import.meta.url), 'utf8');
check('UpstreamError 有 qrExpired 字段', errSrc.includes('qrExpired'), true);

const loginSrc = readFileSync(new URL('../src/channels/doubao/login.ts', import.meta.url), 'utf8');
check('登录流程认 refresh-qr', loginSrc.includes("'refresh-qr'"), true);
check('刷新前先作废旧码', /expireQrCode[\s\S]{0,200}refreshQrCode/.test(loginSrc), true);
check('过期时自动换一张再继续', /isQr && error\?\.qrExpired/.test(loginSrc), true);

const qrCardSrc = readFileSync(new URL('../web/src/components/login/QrVerifyCard.vue', import.meta.url), 'utf8');
check('二维码卡片有刷新按钮', qrCardSrc.includes('刷新二维码'), true);
check('刷新按钮朝外发事件', qrCardSrc.includes("emit('refresh')"), true);
const cardSrc = readFileSync(new URL('../web/src/components/login/PromptCard.vue', import.meta.url), 'utf8');
check('PromptCard 转发刷新事件', cardSrc.includes("answer('refresh-qr')"), true);

done();
