// 2046 验证方式的可做性判定。
//
// 这套钉的是「不会报错、只会让用户白做一遍」的地方：
// 把做不了的方式判成能做 → 用户照着做完，上游永远不认，界面只说「验证失败」；
// 把能做的方式判成做不了 → 用户被迫去导 cookie，其实一条短信就够。
//
// 跑：node test/doubao-verify-ways.mjs
let pass = 0;
let fail = 0;

function check(name, actual, expected = true) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}\n      期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

function section(title) {
  console.log(`\n--- ${title} ---`);
}

const { canVerifyHere } = await import('../src/channels/doubao/verify-ways.ts');
const { VERIFY_WAY_HINTS, riskControlOf } = await import('../src/channels/doubao/risk-control.ts');

section('1. 哪些验证方式网关能做');
// 三种纯 HTTP；抖音授权要跳第三方页面，做不到
check('发短信能做', canVerifyHere('mobile_up_sms_verify'), true);
check('扫码能做', canVerifyHere('qr_code_verify'), true);
check('推送能做', canVerifyHere('push_verify'), true);
check('抖音授权做不了', canVerifyHere('oauth_douyin_verify'), false);
check('刷脸做不了', canVerifyHere('mobile_auth_face_verify'), false);
check('密码验证做不了（网关不知道密码）', canVerifyHere('pwd_verify'), false);
check('空串做不了', canVerifyHere(''), false);

section('2. 每种方式都要有「需要你手里有什么」的说明');
// 用户选方式的依据是这句话，不是方式名。缺了它等于让用户猜。
for (const way of ['mobile_up_sms_verify', 'qr_code_verify', 'push_verify', 'oauth_douyin_verify']) {
  check(`${way} 有说明`, typeof VERIFY_WAY_HINTS[way] === 'string' && VERIFY_WAY_HINTS[way].length > 5, true);
}
check('短信说明提到手机', VERIFY_WAY_HINTS.mobile_up_sms_verify.includes('手机'), true);
check('扫码说明提到另一台设备', VERIFY_WAY_HINTS.qr_code_verify.includes('另一台'), true);
check('推送说明提到另一台设备', VERIFY_WAY_HINTS.push_verify.includes('另一台'), true);
// 做不了的要说清做不了，别让用户选完才发现
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
// 未知方式不能崩，hint 给空串
const unknown = riskControlOf({ data: { error_code: 2046, verify_ways: [{ verify_way: 'brand_new_way' }] } }, 1000);
check('未知方式 hint 为空串', unknown.verifyWays[0].hint, '');
check('未知方式 label 退回原文', unknown.verifyWays[0].label, 'brand_new_way');

section('4. 三种方式对应的接口（逆向自官方页面，钉死别改错）');
// 官方 9888 app-mfa_mobile-up-sms-verify/page → verifyUpSms
// 官方 6193 app-mfa_push-verify/page          → sendPush + checkPushCode（**不是轮询 check_push_result**）
// 官方 4870 app-mfa_qr-code-verify/page       → getQrCode + validateByQrCode（3 秒轮询）
const { readFileSync } = await import('node:fs');
const src = readFileSync(new URL('../src/channels/doubao/verify-ways.ts', import.meta.url), 'utf8');
// 只看真正发请求的路径常量，不管注释里怎么解释这个坑。
const paths = [...src.matchAll(/const\s+[A-Z_]+\s*=\s*'([^']*)'/g)].map((m) => m[1]);
check('短信接口路径', paths.includes('/passport/upsms/verify/'), true);
check('推送接口路径', paths.includes('/passport/web/send_push/'), true);
// 这条最容易搞错：check_push_result 是「一次性登录」用的，不是 MFA 推送验证。
check('推送确认用 check_push_code', paths.includes('/passport/device/check_push_code/'), true);
check('推送确认不用 check_push_result', paths.some((p) => p.includes('check_push_result')), false);
check('扫码取码接口', paths.includes('/passport/web/get_qrcode/'), true);
// 同理：check_qrconnect 是扫码登录用的，MFA 扫码验证走 validate_by_qrcode。
check('扫码验证用 validate_by_qrcode', paths.includes('/passport/web/validate_by_qrcode/'), true);
check('扫码验证不用 check_qrconnect', paths.some((p) => p.includes('check_qrconnect')), false);

section('5. 状态机用官方枚举值（86191.js 的 Xu）');
for (const [name, value] of [
  ['scanned', 'scanned'],
  ['confirmed', 'confirmed'],
  ['refused', 'refused'],
  ['expired', 'expired'],
]) {
  check(`状态 ${name} = ${value}`, src.includes(`'${value}'`), true);
}

section('6. 二维码图片取自哪个字段（实测坑）');
// 2026-11-26 实测：qrcode_index_url 是 scan-login 那个 **HTML 页面**（40KB，<!DOCTYPE），
// 放进 <img src> 白板一块。真正的图在 qrcode 字段，是完整的 data:image/png;base64,…
check('优先用 qrcode 字段', /String\(data\.qrcode\s*\|\|\s*''\)/.test(src), true);
check('不拿 qrcode_index_url 当图片', src.includes('qrcode_index_url ||'), false);
check('注释里记了 qrcode_index_url 是 HTML', src.includes('HTML'), true);

section('7. 每一步都要有日志（跑了没日志 = 白查）');
// 2026-11-26 踩过：`setLoginLogger` 忘了调，整条登录链路一行日志都没有。
// 这里钉住 verify-ways 的每个关键节点都有 loginLog，改代码时删不掉。
for (const [what, pattern] of [
  ['发短信前记录号码和内容', /短信验证：要用户发/],
  ['推送发出后记录设备和 token', /推送验证：已推给设备/],
  ['二维码生成后记录 token', /扫码验证：二维码已生成/],
  ['扫码被扫到时记录', /二维码已被扫描/],
  ['二维码过期时记录', /二维码已过期/],
  ['换新二维码时记录', /已换新二维码/],
  ['短信验证通过记录 ticket', /upsms 验证通过/],
  ['推送验证通过记录 ticket', /push 验证通过/],
  ['扫码验证通过记录 ticket', /扫码验证通过/],
  ['重放原请求记录结果码', /重放原请求/],
]) {
  check(what, pattern.test(src), true);
}

section('8. CSRF token 必须随请求带');
// 2026-11-26 踩过：`send_push` 一直回 `2035 非法请求`，实际 `2035 = CSRF_TOKEN_ERROR`。
// 官方 SDK 用 axios 的 `xsrfCookieName: 'passport_csrf_token'` +
// `xsrfHeaderName: 'x-tt-passport-csrf-token'` 自动带这个头，我们漏了。
// 发码和选号不校验 CSRF，所以只有推送暴露出来——这类「只有某个接口才炸」的漏最费时间。
const passportSrc = readFileSync(new URL('../src/channels/doubao/passport.ts', import.meta.url), 'utf8');
check('带 x-tt-passport-csrf-token 头', passportSrc.includes('x-tt-passport-csrf-token'), true);
check('从 passport_csrf_token 取', passportSrc.includes('passport_csrf_token'), true);
// 两个 cookie 名都要试：上游有时只种 _default 那个
check('回退到 passport_csrf_token_default', passportSrc.includes('passport_csrf_token_default'), true);

section('9. 二维码过期可以刷新（不自动换）');
// 2026-11-26 用户问到「二维码过期能不能刷新」，暴露了原实现的缺陷：
// 后端偷偷换了新码，但界面上还是旧图——用户对着旧码扫，永远扫不进去。
const verifySrc = src;
check('有独立的 refreshQrCode', /export async function refreshQrCode/.test(verifySrc), true);
check('有过期作废接口 expire_qrcode', verifySrc.includes("'/passport/web/expire_qrcode/'"), true);
// 过期要抛「可刷新」信号，不是直接换码
check('过期抛 qrExpired 标记', /qrExpired: true/.test(verifySrc), true);
// 关键：pollQrCode 里不许再有偷偷换码的逻辑
const pollPart = verifySrc.slice(verifySrc.indexOf('async function pollQrCode'), verifySrc.indexOf('export async function refreshQrCode'));
check('pollQrCode 里不再自动换码', /refreshes \+= 1/.test(pollPart), false);
check('pollQrCode 用完就抛过期信号', /status === QR_EXPIRED/.test(pollPart), true);

// UpstreamError 要带这个字段，界面才知道显示刷新按钮
const errSrc = readFileSync(new URL('../src/shared/upstream-error.ts', import.meta.url), 'utf8');
check('UpstreamError 有 qrExpired 字段', errSrc.includes('qrExpired'), true);

// 界面要能把「刷新」这个动作发回后端
const loginSrc = readFileSync(new URL('../src/channels/doubao/login.ts', import.meta.url), 'utf8');
check('登录流程认 refresh-qr', loginSrc.includes("'refresh-qr'"), true);
check('刷新前先作废旧码', /expireQrCode[\s\S]{0,200}refreshQrCode/.test(loginSrc), true);
// 过期自动换一张是允许的（后端知道自己换了，会重新推 prompt 把新图带给界面）
check('过期时自动换一张再继续', /isQr && error\?\.qrExpired/.test(loginSrc), true);

// 前端：二维码卡片要有刷新按钮，且不自己判断过期
const qrCardSrc = readFileSync(new URL('../web/src/components/login/QrVerifyCard.vue', import.meta.url), 'utf8');
check('二维码卡片有刷新按钮', qrCardSrc.includes('刷新二维码'), true);
check('刷新按钮朝外发事件', qrCardSrc.includes("emit('refresh')"), true);
// PromptCard 要把这个事件转成 refresh-qr 回答
const cardSrc = readFileSync(new URL('../web/src/components/login/PromptCard.vue', import.meta.url), 'utf8');
check('PromptCard 转发刷新事件', cardSrc.includes("answer('refresh-qr')"), true);

console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
