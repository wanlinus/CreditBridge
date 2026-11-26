// 豆包风控错误的判定与映射。
//
// 这套代码钉的是「不会报错、只会让账号状态悄悄错」的地方：
// 风控被当成 502 → 路由不改账号状态 → 账号永远显示「就绪」，用户只看到「所有请求都失败」；
// 风控被当成 401 → 账号标 invalid → 用户以为号废了，删了重登又撞风控。
//
// 所以核心断言是**状态码必须是 429**，以及**非风控码不能被误判**。
//
// 跑：node test/doubao-risk-control.mjs
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

const {
  CAPTCHA_PAGE_URL,
  QUERY_DECISION_PATH,
  isRiskControlCode,
  riskControlOf,
  riskControlError,
  riskControlAdvice,
  riskControlChallengeOf,
  challengeName,
} = await import('../src/channels/doubao/risk-control.ts');

section('1. 风控码识别');
for (const code of [2046, 4037, 4038, 4048, 710022004, 1203, 1206, 2068]) {
  check(`${code} 是风控`, isRiskControlCode(code), true);
}
// 非风控码不能误判：这几个是「凭据坏了」「参数错」「要选号」，处置完全不同
for (const code of [0, 13, 16, 2035, 401, 403, 710012001, 710010202, 1204, 1454]) {
  check(`${code} 不是风控`, isRiskControlCode(code), false);
}
check('字符串码也认', isRiskControlCode('2046'), true);
check('undefined 不是风控', isRiskControlCode(undefined), false);

section('2. 从响应里提取');
const resp2046 = {
  data: {
    error_code: 2046,
    description: '为保证账号安全，暂不支持此操作',
    common_params: { ies_safety_diversion_tag: 'mfa' },
  },
};
const info = riskControlOf(resp2046, 1000);
check('2046 能提取', info !== null, true);
check('码对', info.code, 2046);
check('文案带出来', info.message, '为保证账号安全，暂不支持此操作');
check('mfa 标记 → 设备限制', info.deviceBound, true);
check('冷却 10 分钟', info.retryAt - 1000, 600000);

const freqInfo = riskControlOf({ data: { error_code: 4037, description: '频繁' } }, 1000);
check('4037 无 mfa 标记 → 不是设备限制', freqInfo.deviceBound, false);

check('正常响应返回 null', riskControlOf({ code: 0, data: { user_id: '1' } }), null);
check('1454 返回 null（要选号，不是风控）', riskControlOf({ data: { error_code: 1454 } }), null);

section('3. 映射成 UpstreamError');
const err = riskControlError(info, '选号');
check('状态码 429（不是 401/502）', err.status, 429);
check('错误码标记', err.code, 'doubao_risk_control');
check('retryAt 带过去', err.retryAt, info.retryAt);
check('文案含上下文', err.message.includes('选号'), true);
// 错误信息里必须带可执行建议，只说「被风控了」用户没法处理
check('文案给出可执行动作', err.message.includes('设备号') || err.message.includes('导入 cookie'), true);
check('文案提到关掉设备限制这条退路', err.message.includes('关掉'), true);

const freqErr = riskControlError(freqInfo, '发验证码');
check('频率类文案不提设备号', freqErr.message.includes('设备号'), false);

section('4. 操作建议按情况分流');
const deviceAdvice = riskControlAdvice(info);
check('设备限制 → 提设备号', deviceAdvice.includes('设备号'), true);
check('设备限制 → 提导入 cookie', deviceAdvice.includes('导入 cookie'), true);
check('设备限制 → 提关掉设置', deviceAdvice.includes('关掉'), true);

const freqAdvice = riskControlAdvice(freqInfo);
check('频率类 → 提等待', freqAdvice.includes('等'), true);
check('频率类 → 不提设备号', freqAdvice.includes('设备号'), false);

const entAdvice = riskControlAdvice(info, { enterpriseAccount: true });
check('企业账号 → 提 LSA', entAdvice.includes('LSA'), true);
check('企业账号 → 提导入 cookie', entAdvice.includes('导入 cookie'), true);

section('5. 日志里的标注');
// 2046（设备限制）走不通验证 → 标 device_bound；频率类标 risk_control。
// 只有 1105 那种纯前端验证才标 verify_center_captcha（在第 6 节验证）。
check('设备限制 → 标 device_bound', riskControlChallengeOf(info).includes('device_bound'), true);
check('设备限制 → 说明无可用验证入口', riskControlChallengeOf(info).includes('无可执行'), true);
check('频率类 → 标 risk_control', riskControlChallengeOf(freqInfo).includes('risk_control'), true);

section('6. 验证码挑战（关键：数据在 verify_center_decision_conf 里）');
// **挑战数据不在顶层 captcha 字段**（那个一直是空的），
// 在 verify_center_decision_conf.detail 里。2026-11-26 之前查错了字段，
// 误判成「上游不出题」。下面用真实响应钉住这个结构。
const real1105 = {
  data: {
    captcha: '',
    desc_url: '',
    description: '滑动滑块进行验证',
    error_code: 1105,
    verify_center_decision_conf: JSON.stringify({
      code: '10000',
      from: 'shark_admin',
      type: 'verify',
      subtype: 'slide',
      detail: '-sWa519wJBiL8bTeXWYQGWCZETrUieFZBsgTMBxGcMFd2ewPPgbqWlDP5AhfMsM5d3s87vvAb1VOHtYTu1USiXwhTVkLylsVe8kDJB0FB-AZ9HQKMjAXzsXD',
      verify_ticket: 'VTIDEFJD2CGM5UPMN99447MQ8ZHSD9EM8P87U4_lq',
      verify_event: 'tt_send_sms_login',
      verify_scene: 'passport',
    }),
    verify_ticket: 'VTIDEFJD2CGM5UPMN99447MQ8ZHSD9EM8P87U4_lq',
  },
  message: 'error',
};

const realInfo = riskControlOf(real1105, 1000);
check('1105 是风控码', isRiskControlCode(1105), true);
check('1105 能提取', realInfo !== null, true);
check('顶层 captcha 是空的（所以不能靠它）', real1105.data.captcha, '');
check('但从 decision_conf 拿到了挑战', realInfo.challenge !== null, true);
check('挑战码 = detail', realInfo.challenge.code.startsWith('-sWa519'), true);
check('subtype = slide', realInfo.challenge.subtype, 'slide');
check('ticket 带出来', realInfo.challenge.ticket, 'VTIDEFJD2CGM5UPMN99447MQ8ZHSD9EM8P87U4_lq');
check('event 带出来', realInfo.challenge.event, 'tt_send_sms_login');
check('验证页地址', realInfo.challenge.url, CAPTCHA_PAGE_URL);
check('日志标注「已出题」+ slide', riskControlChallengeOf(realInfo).includes('slide'), true);
check('建议改成「按提示操作」', riskControlAdvice(realInfo).includes('按提示操作'), true);
check('建议提到滑动滑块', riskControlAdvice(realInfo).includes('滑动滑块'), true);

// 2046 的响应：**给了 4 种验证方式，其中 3 种网关能纯 HTTP 做完**。
// 2026-11-26 挖完懒加载 chunk 后修正了这个结论——之前的「做不了」是错的。
const real2046 = {
  data: {
    captcha: '',
    desc_url: '',
    description: '为保证账号安全，暂不支持此操作',
    error_code: 2046,
    account_flow: 'verify',
    encrypt_uid: 'Z5+CGJP5X/R12RNugMo9GfXNZ5E7Y6VinR67FjWsuKef+YBBFqPdV2FVjA2OcxWF3UolVGhKlVu8fjIC',
    verify_ticket: '',
    common_params: { ies_safety_diversion_tag: 'mfa' },
    biz_params: {
      passport_mfa_retry_tag: '1',
      register_new_user: 'false',
      sec_uid: 'MS4wLjABAAAAo49xNM68',
      sms_code_key: '7924961ca0a99c2cc11d8bc70adba658',
      sms_code_key_not_mix: '1',
    },
    verify_ways: [
      { verify_way: 'qr_code_verify', nick_name: '我快乐' },
      {
        verify_way: 'mobile_up_sms_verify',
        channel_mobile: '10691859839103',
        mobile: '155******33',
        sms_content: 'YZ',
      },
      { verify_way: 'push_verify', nick_name: '我快乐' },
      { verify_way: 'oauth_douyin_verify', platform_screen_name: '**乐' },
    ],
  },
};
const info2046 = riskControlOf(real2046, 1000);
check('2046 没有可直接执行的验证题', info2046.challenge, null);
check('2046 提取到 4 种验证方式', info2046.verifyWays.length, 4);
check('扫码方式中文名', info2046.verifyWays[0].label, '使用原设备扫码');
check('发短信方式带号码', info2046.verifyWays[1].channelMobile, '10691859839103');
check('发短信方式带内容', info2046.verifyWays[1].smsContent, 'YZ');
check('发短信方式带手机号', info2046.verifyWays[1].mobile, '155******33');
check('抖音方式带昵称', info2046.verifyWays[3].platformName, '**乐');
// 文案必须说清「上游要什么」+「在哪儿做」。2046 的验证方式网关能带用户做完。
check('建议提到上游要的方式', riskControlAdvice(info2046).includes('发送短信验证码'), true);
check('建议说明在登录弹窗里做', riskControlAdvice(info2046).includes('登录弹窗'), true);
check('日志标注验证方式', riskControlChallengeOf(info2046).includes('qr_code_verify'), true);
// 查验证决策的接口是纯 HTTP 的（2026-11-26 实测通），路径常量要留着
check('查决策接口路径', QUERY_DECISION_PATH, '/passport/safe/query_decision/');

// 重放原请求要的上下文：缺了它验证通过也没法继续（SDK 的 processPlugin 行为）
check('2046 带出重放上下文', info2046.verification !== null, true);
check('重放上下文带 encrypt_uid', info2046.verification.encryptUid.startsWith('Z5+CGJP5'), true);
check('重放上下文带 biz_params', info2046.verification.bizParams.sms_code_key, '7924961ca0a99c2cc11d8bc70adba658');
check('biz_params 里 sec_uid 保留', info2046.verification.bizParams.sec_uid, 'MS4wLjABAAAAo49xNM68');
// resendPath / resendForm 上游不给，由登录流程填——这里是空的，不是 bug
check('resendPath 留给调用方填', info2046.verification.resendPath, '');
// 没有 biz_params 的 2046 就构不出上下文（别硬编一个空的出来）
check(
  '缺 biz_params 时上下文为 null',
  riskControlOf({ data: { error_code: 2046 } }, 1000).verification,
  null,
);

// 错误对象要带上挑战，界面才知道渲染什么
const challengeErr = riskControlError(realInfo, '发验证码');
check('UpstreamError 带 challenge', challengeErr.challenge !== null, true);
check('challenge 内容对', challengeErr.challenge.subtype, 'slide');
check('硬拒绝时 challenge 为 null', riskControlError(info2046, '选号').challenge, null);

// 类型中文名
check('slide → 滑动滑块', challengeName('slide'), '滑动滑块');
check('semantic_reasoning → 按提示点选', challengeName('semantic_reasoning'), '按提示点选');
check('未知类型有兜底', challengeName('whatever'), '图形验证码');

console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
