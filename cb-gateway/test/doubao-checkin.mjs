// 豆包签到。
//
// 这套钉的是「不会报错、只会静默不签到」的地方：
//
// 1. **`idempotent: true` 必须映射成 `already` 而不是 `error`**——上游对重复签到
//    是回 200 + idempotent，当成失败会让调度器一直重试，日志里全是假失败。
// 2. **`pc_version` 为空时必须自己拦下来**——上游会回 `710010702 系统错误`，
//    那个码和「cookie 过期」长得一样，排查时会往完全错的方向走。
// 3. **必须写 `checkin_state`**——不落盘的话调度器每天都会重新领一遍。
//
// 签到和额度都在 `usage.ts` 里（和其他四个通道一致，没有独立的 checkin 文件）。
//
// 跑：node test/doubao-checkin.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-dbcheckin-'));
process.env.QB_DATA_DIR = tempData;
fs.mkdirSync(path.join(tempData, 'auth'), { recursive: true });
fs.writeFileSync(path.join(tempData, 'config.json'), JSON.stringify({}));

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

const auth = await import('../src/channels/doubao/auth.ts');
const usage = await import('../src/channels/doubao/usage.ts');

section('1. 没凭据直接失败，不发请求');
{
  // 先注入版本号，否则会先撞「版本号为空」那道守卫——那是第 2 段要验的。
  auth.configureIdentity('2.38.7');
  const record = await usage.claimCheckin({ id: 'db-x', channelId: 'doubao', credential: null });
  check('status=error', record.status, 'error');
  check('消息说明凭据', /凭据/.test(record.message || ''), true);
  check('带 date 字段', /^\d{4}-\d{2}-\d{2}$/.test(record.date), true);
}

section('2. 版本号守卫排在凭据检查之前');
{
  // 版本号为空时，即使凭据也缺，报的应该是版本问题——
  // 因为版本空会让上游回 710010702，那个码看起来像 cookie 过期，先拦下来更省事。
  // 这条靠源码断言（运行时改不回空版本，configureIdentity 只在非空时赋值）。
  const src = fs.readFileSync(new URL('../src/channels/doubao/usage.ts', import.meta.url), 'utf8');
  // 只看 claimCheckin 的函数体内，别拿 getCredits 里的 usableCredential 当锚点。
  const fnStart = src.indexOf('export async function claimCheckin');
  const fnBody = src.slice(fnStart);
  const guardIdx = fnBody.indexOf('if (!DOUBAO_VERSION)');
  const credIdx = fnBody.indexOf('usableCredential(account');
  check('版本号守卫存在', guardIdx > 0, true);
  check('版本号守卫在凭据获取之前', guardIdx > 0 && credIdx > 0 && guardIdx < credIdx, true);
}

section('3. 本地记录读写');
{
  // `checkin_state.account` 有外键挂 `account(id)`，所以必须先建账号。
  const accounts = await import('../src/core/accounts.ts');
  accounts.loadAccounts();
  const account = accounts.addAccount({
    channelId: 'doubao',
    idPrefix: 'db',
    credential: { cookies: {}, deviceId: '1', webId: '0', uid: 'u', source: 'test' },
    label: '签到测试号',
  });

  check('新账号没有签到记录', usage.readLastCheckin(account), null);

  const { writeCheckinState } = await import('../src/core/checkin-store.ts');
  const ok = writeCheckinState(account, { date: '2026-01-01', status: 'checked', credits: 200 });
  check('写入成功', ok, true);
  const back = usage.readLastCheckin(account);
  check('写进去能读出来', back?.status, 'checked');
  check('credits 保留', back?.credits, 200);
}

section('4. 源码层面的关键断言');
{
  const src = fs.readFileSync(new URL('../src/channels/doubao/usage.ts', import.meta.url), 'utf8');

  // 活动 ID 与接口路径
  check('activity id 是 pc_incentive_task_mvp_v3', src.includes("'pc_incentive_task_mvp_v3'"), true);
  check('接口路径正确', src.includes("'/alice/ug/campaign/landing/checkin'"), true);

  // idempotent 映射
  check('认 idempotent 字段', src.includes('data.idempotent'), true);
  check('idempotent 映射成 already', /idempotent === true[\s\S]{0,300}status: 'already'/.test(src), true);

  // 版本号守卫：空版本要提前返回，不能去撞 710010702
  check('有版本号守卫', /if \(!DOUBAO_VERSION\)/.test(src), true);
  check('710010702 单独说明', src.includes('710010702'), true);

  // 落盘：签到状态必须写 checkin_state，否则每天重领
  check('用了 writeCheckinState', src.includes('writeCheckinState'), true);
  check('用了 keepEarlierSuccess（避免 already 覆盖真签到）', src.includes('keepEarlierSuccess'), true);

  // 日期口径统一：用 shared/clock 的 localDate，别自己拼
  check('用 localDate()', src.includes('localDate('), true);
  check('没有自己拼日期', /getFullYear\(\)/.test(src), false);
}

section('5. 通道接线 + 结构一致性');
{
  const indexSrc = fs.readFileSync(new URL('../src/channels/doubao/index.ts', import.meta.url), 'utf8');
  check('实现了 checkinClaimOf', /checkinClaimOf\(account\)/.test(indexSrc), true);
  check('实现了 lastCheckinOf', /lastCheckinOf\(account\)/.test(indexSrc), true);
  check('签到日志走 setUsageLogger', indexSrc.includes('setUsageLogger(log)'), true);

  // 结构和另外四个通道一致：只有 7 个标准文件 + 登录链路的辅助模块
  const dir = new URL('../src/channels/doubao/', import.meta.url);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .sort();
  const STANDARD = ['auth.ts', 'index.ts', 'login.ts', 'models.ts', 'upstream.ts', 'usage.ts'];
  // passport / risk-control / verify-ways 是登录链路的辅助模块，
  // 和 qoder 的 sse.ts、loomy 的 sign.ts 同类。
  const HELPERS = ['passport.ts', 'risk-control.ts', 'verify-ways.ts'];
  const unexpected = files.filter((f) => !STANDARD.includes(f) && !HELPERS.includes(f));
  check('没有非标准文件', unexpected, []);
  check('标准文件齐全', STANDARD.filter((f) => !files.includes(f)), []);
  // 不能有独立的 checkin 文件（其他四个通道都写在 usage.ts）
  check('没有独立 checkin.ts', files.includes('checkin.ts'), false);
  // logger-types 已并入各文件的 fn: any，和另外四个通道一致
  check('没有 logger-types.ts', files.includes('logger-types.ts'), false);
}

console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
