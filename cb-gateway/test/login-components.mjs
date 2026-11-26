// 登录弹窗的组件拆分。
//
// 这套钉的是「拆完以后没人发现坏掉」的地方：组件之间靠 `login/*` 的字段约定连接，
// 字段名写错不会报错——模板里就是 `undefined`，界面直接空一块。
//
// 特别是这三条：
// - `sms` / `qrCode` / `otpLength` 三个字段的**优先级**（一个 prompt 可能同时带 options）
// - 「做不了的方式」要灰掉但**仍然显示**（隐藏会让用户以为网关漏了一种）
// - `qrcode_index_url` 不能当图片用（那是 HTML 页面，塞 img 白板一片）
//
// 跑：node test/login-components.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

// 路径全部从本文件位置推导，**不能写绝对路径**——CI 上仓库在
// `/home/runner/work/<repo>/<repo>/`，写死 `D:/Code/...` 会在 CI 里 ENOENT，
// 而本地看着一切正常。2026-11-26 就是这么让 CI 红的。
//
// 用 `fileURLToPath` 而不是 `new URL(...).pathname`：后者在 Windows 上给出
// `/D:/Code/...`（多了前导斜杠），`path.join` 拼出来是坏路径。
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(TEST_DIR, '..', 'web', 'src');
/** 读 web/src 下的文件。 */
const read = (rel) => fs.readFileSync(path.join(WEB, ...rel.split('/')), 'utf8');
/** 读 cb-gateway/ 下的文件（路径用 `/` 分隔）。 */
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
for (const [label, rel] of Object.entries(FILES)) {
  check(`${label} 存在`, fs.existsSync(`${WEB}/${rel}`), true);
}

section('2. PromptCard 的分派优先级');
const promptCard = read('components/login/PromptCard.vue');
// 顺序必须是 sms → challenge → qrCode → otpLength → options → 文本
// 因为一个 prompt 可能同时带 options（"换一种方式"按钮）和 qrCode。
const order = ['prompt.sms', 'prompt.challenge', 'prompt.qrCode', 'prompt.otpLength', 'prompt.options?.length'];
const positions = order.map((key) => promptCard.indexOf(key));
check('五个分支都出现了', positions.every((p) => p >= 0), true);
check(
  '顺序是 sms → challenge → qrCode → otp → options',
  positions.every((p, i) => i === 0 || p > positions[i - 1]),
  true,
);
// 有 qrCode / sms / otp 时，options 要单独渲染成底部按钮，不能当主选项卡片
check('特殊形态的 options 走底部 extra 区', promptCard.includes('class="extra"'), true);

section('3. 做不了的方式要灰掉但仍然显示');
const choiceList = read('components/login/ChoiceList.vue');
check('ChoiceList 认 disabled', choiceList.includes('option.disabled'), true);
check('禁用项仍渲染', choiceList.includes('v-for="option in options"'), true);
check('禁用项给出「做不了」标记', choiceList.includes('做不了'), true);
// 隐藏 vs 灰掉：这里断言的是 :disabled 而不是 v-if 过滤
check('用的是 disabled 不是过滤', /:disabled="disabled \|\| option\.disabled"/.test(choiceList), true);

section('4. 后端把 impossible 的方式标成 disabled');
const loginTs = readRepo('src/channels/doubao/login.ts');
check('verify-way 选项带 disabled', /disabled: !canVerifyHere\(item\.way\)/.test(loginTs), true);
// hint 必须原样传，不然前端要自己拼「做不了」那句
check('hint 原样传下去', /hint: item\.hint/.test(loginTs), true);

section('5. 短信字段结构化传下去');
// 挤进 label 会让用户在两处对照，容易抄错
check('后端有 sms 字段', /sms: \{/.test(loginTs), true);
check('sms 带 channelMobile', /channelMobile: way\.channelMobile/.test(loginTs), true);
check('sms 带 content', /content: way\.smsContent/.test(loginTs), true);
check('sms 带 mobile', /mobile: way\.mobile/.test(loginTs), true);
// instruction 里不该再重复号码（卡片已经分段显示了）
const verifyWays = readRepo('src/channels/doubao/verify-ways.ts');
check(
  '短信 instruction 不重复号码',
  /instruction: '用手机发一条短信完成验证'/.test(verifyWays),
  true,
);
check(
  '扫码 instruction 不重复说明',
  /instruction: '用已登录豆包的手机扫码完成验证'/.test(verifyWays),
  true,
);

section('6. 二维码不能拿 qrcode_index_url');
const qrCard = read('components/login/QrVerifyCard.vue');
check('二维码卡片只吃 src', qrCard.includes('defineProps'), true);
// 只看模板和脚本，注释里解释这个坑是应该的。
const qrCodeOnly = qrCard.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
check('代码里没用 qrcode_index_url', qrCodeOnly.includes('qrcode_index_url'), false);
// 注释里要记这个坑，不然下次还会踩
check('注释记了 qrcode_index_url 的坑', qrCard.includes('HTML 页面'), true);
check('二维码不缩放模糊', qrCard.includes('pixelated'), true);

section('7. OTP 会填满自动提交');
const otp = read('components/login/OtpInput.vue');
check('OTP 有 length 属性', otp.includes('length: number'), true);
check('OTP 填满自动 emit', /watch\(complete/.test(otp), true);
check('OTP 过滤非数字', otp.includes('replace(/\\D/g'), true);

section('8. useLoginPrompt 的两个坑');
const composable = read('composables/useLoginPrompt.ts');
// 坑 1：按 id 判断要不要清空输入框，不能让每 1.2 秒的快照清掉用户输入
check('换 prompt 才清空（按 id）', /task\(\)\.prompt\?\.id/.test(composable), true);
// 坑 2：提交后要留住 prompt，否则表单被卸掉
check('有 pendingPrompt 顶住', composable.includes('pendingPrompt'), true);
check('activePrompt 优先用新鲜的', /task\(\)\.prompt \?\? pendingPrompt\.value/.test(composable), true);

section('9. 弹窗外壳不再自己实现交互');
const panel = read('components/LoginTaskPanel.vue');
// 拆完以后外壳只该管布局和状态分支，不该再有 prompt 的渲染细节
check('外壳用 useLoginPrompt', panel.includes('useLoginPrompt'), true);
check('外壳用 PromptCard', panel.includes('PromptCard'), true);
check('外壳用 AuthLinkList', panel.includes('AuthLinkList'), true);
// 这些是拆出去的，外壳里不该再有
check('外壳不再嵌 iframe', panel.includes('<iframe'), false);
check('外壳不再有 qr-image 样式', panel.includes('.qr-image'), false);
check('外壳不再有 otp-input 样式', panel.includes('.otp-input'), false);

section('10. 登录流程每一步都要有日志');
// 2026-11-26 踩过：`setLoginLogger` 忘了调，整条登录链路一行日志都没有，
// 排查 2046 时看不到用的哪个设备号。这里钉住 askVerify 的每个分支。
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
]) {
  check(what, pattern.test(loginTs), true);
}

section('11. 输入框不能用 type="number"（导致整个弹窗崩白）');
// 2026-11-26 真实崩溃：豆包 code 步骤的 prompt 是 `inputType: 'number'`，
// 直接给 `<input :type="prompt.inputType">` 的话，Vue 3 会把 v-model 的值转成 Number，
// 于是 `text.value.trim()` 抛 TypeError，组件崩掉、弹窗 body 变空白。
// 用户看到的只是「一输入验证码弹窗就没了」，控制台里才有那段栈。
const promptCardSrc = read('components/login/PromptCard.vue');
// 断言：模板里的 type 是写死的 text，不是绑定的
check('type 写死为 text', /<input[\s\S]{0,200}?type="text"/.test(promptCardSrc), true);
check('不再把 inputType 直接绑给 type', /:type="prompt\.inputType/.test(promptCardSrc), false);
// 数字键盘靠 inputmode，这才是它的用途
check('用 inputmode 控制键盘', promptCardSrc.includes('inputmode'), true);
// 防御：即使真的进来非字符串也不该崩
check('submitText 做了 String() 兜底', /String\(text\.value \?\? ''\)/.test(promptCardSrc), true);
check('模板里的 trim 前面有 String()', /String\(text\)\.trim\(\)/.test(promptCardSrc), true);

section('12. 全项目不许再把 v-model 绑到 number 型输入');
// `.trim()` / `.length` 这类字符串方法在 Number 上会抛错，而抛错发生在**渲染期**
// （模板里表达式求值），整个组件树会被卸载，界面只剩空壳。
// 除了显式 `v-model.number`（明确要数字）之外，其余一律 type="text" + inputmode。
const webFiles = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.vue')) webFiles.push(full);
  }
}
walk(`${WEB}`);
const offenders = [];
for (const file of webFiles) {
  const src = fs.readFileSync(file, 'utf8');
  // 找 `v-model="xxx"` 且同标签里有 `type="number"` 的
  for (const m of src.matchAll(/<input\b[^>]*>/g)) {
    const tag = m[0];
    if (/type="number"/.test(tag) && /v-model="[^"]+"/.test(tag) && !/v-model\.number/.test(tag)) {
      offenders.push(file.replace(WEB, '').replace(/\\/g, '/'));
    }
  }
}
check('没有 v-model 绑 number 型输入', offenders, []);

console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
