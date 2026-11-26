// 守护：风控被当成 502/401 会让账号状态悄悄错——状态码必须是 429，非风控码不能误判。
import { check, section, done } from './_helpers.mjs';

const {
  CAPTCHA_PAGE_URL, QUERY_DECISION_PATH, isRiskControlCode, riskControlOf,
  riskControlError, riskControlAdvice, riskControlChallengeOf, challengeName,
} = await import('../src/channels/doubao/risk-control.ts');

section('1. 风控码识别');
// 非风控码是「凭据坏/参数错/要选号」，处置完全不同，不能误判
for (const code of [2046, 4037, 4038, 4048, 710022004, 1203, 1206, 2068, '2046']) {
  check(`${code} 是风控`, isRiskControlCode(code), true);
}
for (const code of [0, 13, 16, 2035, 401, 403, 710012001, 710010202, 1204, 1454, undefined]) {
  check(`${code} 不是风控`, isRiskControlCode(code), false);
}

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
check('4037 无 mfa → 不是设备限制', freqInfo.deviceBound, false);
check('正常响应返回 null', riskControlOf({ code: 0, data: { user_id: '1' } }), null);
check('1454 返回 null（要选号，不是风控）', riskControlOf({ data: { error_code: 1454 } }), null);

section('3. 映射成 UpstreamError');
const err = riskControlError(info, '选号');
check('状态码 429（不是 401/502）', err.status, 429);
check('错误码标记', err.code, 'doubao_risk_control');
check('retryAt 带过去', err.retryAt, info.retryAt);
check('文案含上下文', err.message.includes('选号'), true);
check('文案给出可执行动作', err.message.includes('设备号') || err.message.includes('导入 cookie'), true);
check('文案提到关掉设备限制', err.message.includes('关掉'), true);
check('频率类文案不提设备号', riskControlError(freqInfo, '发验证码').message.includes('设备号'), false);

section('4. 操作建议按情况分流');
const deviceAdvice = riskControlAdvice(info);
for (const k of ['设备号', '导入 cookie', '关掉']) check(`设备限制建议含「${k}」`, deviceAdvice.includes(k), true);
const freqAdvice = riskControlAdvice(freqInfo);
check('频率类提等待', freqAdvice.includes('等'), true);
check('频率类不提设备号', freqAdvice.includes('设备号'), false);
const entAdvice = riskControlAdvice(info, { enterpriseAccount: true });
check('企业账号提 LSA', entAdvice.includes('LSA'), true);
check('企业账号提导入 cookie', entAdvice.includes('导入 cookie'), true);

section('5. 日志里的标注');
check('设备限制标 device_bound', riskControlChallengeOf(info).includes('device_bound'), true);
check('设备限制说明无可用验证入口', riskControlChallengeOf(info).includes('无可执行'), true);
check('频率类标 risk_control', riskControlChallengeOf(freqInfo).includes('risk_control'), true);

section('6. 验证码挑战（数据在 verify_center_decision_conf，不在顶层 captcha）');
const real1105 = {
  data: {
    captcha: '',
    desc_url: '',
    description: '滑动滑块进行验证',
    error_code: 1105,
    verify_center_decision_conf: JSON.stringify({
      code: '10000', from: 'shark_admin', type: 'verify', subtype: 'slide',
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
check('顶层 captcha 空（所以不能靠它）', real1105.data.captcha, '');
check('从 decision_conf 拿到挑战', realInfo.challenge !== null, true);
check('挑战码 = detail', realInfo.challenge.code.startsWith('-sWa519'), true);
check('subtype = slide', realInfo.challenge.subtype, 'slide');
check('ticket 带出来', realInfo.challenge.ticket, 'VTIDEFJD2CGM5UPMN99447MQ8ZHSD9EM8P87U4_lq');
check('event 带出来', realInfo.challenge.event, 'tt_send_sms_login');
check('验证页地址', realInfo.challenge.url, CAPTCHA_PAGE_URL);
check('日志标注「已出题」+ slide', riskControlChallengeOf(realInfo).includes('slide'), true);
check('建议「按提示操作」', riskControlAdvice(realInfo).includes('按提示操作'), true);
check('建议提到滑动滑块', riskControlAdvice(realInfo).includes('滑动滑块'), true);

// 2046 给了 4 种验证方式，3 种网关能纯 HTTP 做完
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
      { verify_way: 'mobile_up_sms_verify', channel_mobile: '10691859839103', mobile: '155******33', sms_content: 'YZ' },
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
check('建议提到发送短信验证码', riskControlAdvice(info2046).includes('发送短信验证码'), true);
check('建议说明在登录弹窗做', riskControlAdvice(info2046).includes('登录弹窗'), true);
check('日志标注验证方式', riskControlChallengeOf(info2046).includes('qr_code_verify'), true);
check('查决策接口路径', QUERY_DECISION_PATH, '/passport/safe/query_decision/');
check('2046 带出重放上下文', info2046.verification !== null, true);
check('重放上下文带 encrypt_uid', info2046.verification.encryptUid.startsWith('Z5+CGJP5'), true);
check('biz_params 里 sms_code_key 保留', info2046.verification.bizParams.sms_code_key, '7924961ca0a99c2cc11d8bc70adba658');
check('biz_params 里 sec_uid 保留', info2046.verification.bizParams.sec_uid, 'MS4wLjABAAAAo49xNM68');
check('resendPath 留给调用方填', info2046.verification.resendPath, '');
check('缺 biz_params 时上下文为 null', riskControlOf({ data: { error_code: 2046 } }, 1000).verification, null);

check('UpstreamError 带 challenge', riskControlError(realInfo, '发验证码').challenge !== null, true);
check('challenge 内容对', riskControlError(realInfo, '发验证码').challenge.subtype, 'slide');
check('硬拒绝时 challenge 为 null', riskControlError(info2046, '选号').challenge, null);

check('slide → 滑动滑块', challengeName('slide'), '滑动滑块');
check('semantic_reasoning → 按提示点选', challengeName('semantic_reasoning'), '按提示点选');
check('未知类型有兜底', challengeName('whatever'), '图形验证码');

done();
