// 守护：组件之间靠 `login/*` 字段约定连接，字段名写错不报错——模板里就是 undefined，界面空一块。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, section, done } from './_helpers.mjs';

// 路径从本文件位置推导，不能写绝对路径——CI 上仓库路径不同，写死会 ENOENT。
// 用 fileURLToPath 而非 new URL().pathname：后者在 Windows 上多前导斜杠，path.join 拼出坏路径。
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(TEST_DIR, '..', 'web', 'src');
const read = (rel) => fs.readFileSync(path.join(WEB, ...rel.split('/')), 'utf8');
const readRepo = (rel) => fs.readFileSync(path.join(TEST_DIR, '..', ...rel.split('/')), 'utf8');

section('1. 组件文件都在');
const FILES = {
  '弹窗外壳': 'components/LoginTaskPanel.vue',
  '输入形态分派': 'components/login/PromptCard.vue',
  '选项卡片': 'components/login/ChoiceList.vue',
  '短信卡片': 'components/login/SmsVerifyCard.vue',
  '二维码卡片': 'components/login/QrVerifyCard.vue',
  'OTP 输入': 'components/login/OtpInput.vue',
  '图形验证码': 'components/login/CaptchaCard.vue',
  '授权链接': 'components/login/AuthLinkList.vue',
  '交互状态': 'composables/useLoginPrompt.ts',
};
for (const [label, rel] of Object.entries(FILES)) check(`${label} 存在`, fs.existsSync(`${WEB}/${rel}`), true);

section('2. PromptCard 的分派优先级');
const promptCard = read('components/login/PromptCard.vue');
const order = ['prompt.sms', 'prompt.challenge', 'prompt.qrCode', 'prompt.otpLength', 'prompt.options?.length'];
const positions = order.map((key) => promptCard.indexOf(key));
check('五个分支都出现了', positions.every((p) => p >= 0), true);
check('顺序是 sms → challenge → qrCode → otp → options', positions.every((p, i) => i === 0 || p > positions[i - 1]), true);
check('特殊形态的 options 走底部 extra 区', promptCard.includes('class="extra"'), true);

section('3. 做不了的方式要灰掉但仍然显示');
const choiceList = read('components/login/ChoiceList.vue');
check('ChoiceList 认 disabled', choiceList.includes('option.disabled'), true);
check('禁用项仍渲染', choiceList.includes('v-for="option in options"'), true);
check('禁用项给出「做不了」标记', choiceList.includes('做不了'), true);
check('用的是 disabled 不是过滤', /:disabled="disabled \|\| option\.disabled"/.test(choiceList), true);

section('4. 后端把 impossible 的方式标成 disabled');
const loginTs = readRepo('src/channels/doubao/login.ts');
check('verify-way 选项带 disabled', /disabled: !canVerifyHere\(item\.way\)/.test(loginTs), true);
check('hint 原样传下去', /hint: item\.hint/.test(loginTs), true);

section('5. 短信字段结构化传下去');
check('后端有 sms 字段', /sms: \{/.test(loginTs), true);
check('sms 带 channelMobile', /channelMobile: way\.channelMobile/.test(loginTs), true);
check('sms 带 content', /content: way\.smsContent/.test(loginTs), true);
check('sms 带 mobile', /mobile: way\.mobile/.test(loginTs), true);
const verifyWays = readRepo('src/channels/doubao/verify-ways.ts');
check('短信 instruction 不重复号码', /instruction: '用手机发一条短信完成验证'/.test(verifyWays), true);
check('扫码 instruction 不重复说明', /instruction: '用已登录豆包的手机扫码完成验证'/.test(verifyWays), true);

section('6. 二维码不能拿 qrcode_index_url');
const qrCard = read('components/login/QrVerifyCard.vue');
check('二维码卡片只吃 src', qrCard.includes('defineProps'), true);
const qrCodeOnly = qrCard.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
check('代码里没用 qrcode_index_url', qrCodeOnly.includes('qrcode_index_url'), false);
check('注释记了 qrcode_index_url 的坑', qrCard.includes('HTML 页面'), true);
check('二维码不缩放模糊', qrCard.includes('pixelated'), true);

section('7. OTP 会填满自动提交');
const otp = read('components/login/OtpInput.vue');
check('OTP 有 length 属性', otp.includes('length: number'), true);
check('OTP 填满自动 emit', /watch\(complete/.test(otp), true);
check('OTP 过滤非数字', otp.includes('replace(/\\D/g'), true);

section('8. useLoginPrompt 的两个坑');
const composable = read('composables/useLoginPrompt.ts');
check('换 prompt 才清空（按 id）', /task\(\)\.prompt\?\.id/.test(composable), true);
check('有 pendingPrompt 顶住', composable.includes('pendingPrompt'), true);
check('activePrompt 优先用新鲜的', /task\(\)\.prompt \?\? pendingPrompt\.value/.test(composable), true);

section('9. 弹窗外壳不再自己实现交互');
const panel = read('components/LoginTaskPanel.vue');
check('外壳用 useLoginPrompt', panel.includes('useLoginPrompt'), true);
check('外壳用 PromptCard', panel.includes('PromptCard'), true);
check('外壳用 AuthLinkList', panel.includes('AuthLinkList'), true);
check('外壳不再嵌 iframe', panel.includes('<iframe'), false);
check('外壳不再有 qr-image 样式', panel.includes('.qr-image'), false);
check('外壳不再有 otp-input 样式', panel.includes('.otp-input'), false);

section('10. 登录流程每一步都要有日志');
for (const [what, pattern] of [
  ['列出可选/不可选方式', /给用户选验证方式/],
  ['用户选了哪种', /用户选了 way=/],
  ['用户选了做不了的方式', /用户选了网关做不了的方式/],
  ['用户放弃', /这步放弃/],
  ['用户换方式', /换一种方式/],
  ['用户要求重新推送', /用户要求重新推送/],
  ['提交了推送码', /用户提交了推送验证码/],
  ['确认失败', /确认验证失败/],
  ['重填验证码', /重填了推送码/],
]) check(what, pattern.test(loginTs), true);

section('11. 输入框不能用 type="number"（导致整个弹窗崩白）');
// 豆包 code 步骤 inputType: 'number' 时，Vue 3 把 v-model 值转 Number，text.value.trim() 抛 TypeError
const promptCardSrc = read('components/login/PromptCard.vue');
check('type 写死为 text', /<input[\s\S]{0,200}?type="text"/.test(promptCardSrc), true);
check('不再把 inputType 直接绑给 type', /:type="prompt\.inputType/.test(promptCardSrc), false);
check('用 inputmode 控制键盘', promptCardSrc.includes('inputmode'), true);
check('submitText 做了 String() 兜底', /String\(text\.value \?\? ''\)/.test(promptCardSrc), true);
check('模板里的 trim 前面有 String()', /String\(text\)\.trim\(\)/.test(promptCardSrc), true);

section('12. 全项目不许再把 v-model 绑到 number 型输入');
const webFiles = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.vue')) webFiles.push(full);
  }
})(WEB);
const offenders = [];
for (const file of webFiles) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/<input\b[^>]*>/g)) {
    if (/type="number"/.test(m[0]) && /v-model="[^"]+"/.test(m[0]) && !/v-model\.number/.test(m[0])) {
      offenders.push(file.replace(WEB, '').replace(/\\/g, '/'));
    }
  }
}
check('没有 v-model 绑 number 型输入', offenders, []);

done();
