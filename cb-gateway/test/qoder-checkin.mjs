// Qoder 签到领取的回归测试：请求头 + 「空数组不等于已签」。
//
// 钉住 2026-11-14 定位到的那个 bug：
//
//   上游 `/sash/api/v1/me/campaigns` 在**少了 `cosy-clienttype` 头**时会静默返回
//   `{claimable:false, campaigns:[]}` —— 和「今天已经领完了」逐字节相同。而旧代码把
//   「空数组」直接当成 `already`，于是从 2026-11-11 上线起，qd-1 **一次都没真领到过**，
//   日志里 13 条 `already` 全是假的，面板上却一直显示正常。
//
// 所以这里钉四件事：
//   1. 请求必须带 `cosy-clienttype: 10`（缺了上游就不认）；
//   2. 空数组 + 无 claimable 信号 → **不能**记 `already`，要记 error 且标 transient；
//   3. 空数组 + `claimable: true` → 记 `already`（这是真正的「领过了」）；
//   4. 有可领项 → 真发 POST claim，记 `checked` 并带上积分。
//
// 跑：node test/qoder-checkin.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-qoder-checkin-'));
process.env.QB_DATA_DIR = tempData;

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

const usage = await import('../src/channels/qoder/usage.ts');
const accounts = await import('../src/core/accounts.ts');

/**
 * 把时钟钉在**签到窗口已开之后**（下午 14:00）。
 *
 * `claimCheckin()` 内部调 `isBeforeCheckinWindow()`（无参，取 `Date.now()`），窗口没开
 * 时走 `pending` 分支——于是这组测试**在凌晨 00:00~10:00 之间跑必然失败**，而那是
 * 真实缺陷之外的东西：测的是「空数组该记 error 还是 already」，跟几点钟无关。
 *
 * 钉住时钟而不是改生产代码的签名：`at` 参数是给 `isBeforeCheckinWindow()` 单元测试用的，
 * `claimCheckin()` 没必要为测试多一个入参。
 */
const FIXED_NOW = (() => {
  const at = new Date();
  at.setHours(14, 0, 0, 0);
  return at.getTime();
})();
Date.now = () => FIXED_NOW;

/**
 * 本地签到用的「今天」是**北京时间**，和通道内部一致。
 *
 * 测试里必须用同一个算法，否则跨时区跑会得到不同日期、幂等短路不生效。
 */
function usageLocalDate() {
  const now = new Date();
  const shifted = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60 * 1000);
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, '0')}-${String(shifted.getDate()).padStart(2, '0')}`;
}

/**
 * 账号必须**真的建进库里**。
 *
 * `checkin_state` 有 `REFERENCES account(id) ON DELETE CASCADE`，账号不在库里时
 * `writeCheckinState()` 会返回 false、读回来是 `null`——幂等短路于是失效，看起来像
 * 「本地记录没生效」。这个坑在写这组测试时当场踩到一次。
 */
const baseCredential = {
  token: 'dt-fake-token-for-test',
  refreshToken: 'drt-fake',
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  refreshTokenExpiresAt: new Date(Date.now() + 7200_000).toISOString(),
  userId: 'u-test',
  username: '测试号',
  source: 'device-flow',
  savedAt: Date.now(),
};
const created = accounts.addAccount({ channelId: 'qoder', idPrefix: 'qd', credential: baseCredential, label: '测试号' });
const account = { ...created, credential: baseCredential };

const CAMPAIGNS_PATH = '/sash/api/v1/me/campaigns';

let calls = [];
let headersSeen = [];
let plan = {};

function fakeResponse(json, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(json) };
}

globalThis.fetch = async (url, init = {}) => {
  const pathname = new URL(url).pathname;
  calls.push({ method: init.method || 'GET', pathname });
  headersSeen.push({ ...(init.headers || {}) });
  const queue = plan[pathname];
  if (!queue || queue.length === 0) throw new Error(`测试没给 ${pathname} 排响应`);
  return fakeResponse(queue.shift());
};

function reset() {
  calls = [];
  headersSeen = [];
  plan = {};
}

/** 上游「不认这个请求」时的原样返回：空、无任何正面信号。 */
const EMPTY_NO_SIGNAL = { shouldShowCampaignPopup: false, uid: 'u-test', showCampaign: false, claimable: false, campaignUrl: '', campaigns: [] };

/** 上游「今天已经领过」：campaignable 仍为 true，但可领项已变 CLAIMED。 */
const ALREADY = {
  shouldShowCampaignPopup: false,
  uid: 'u-test',
  showCampaign: true,
  claimable: false,
  campaignUrl: 'https://gateway.qoder.com.cn/growth-page/activity-iframe',
  campaigns: [
    {
      campaignId: '01a1bbe5-a108-7c04-90e9-a6ae2f2123cc',
      campaignKey: 'act-20261109-678',
      actionType: 'CLAIM_BENEFIT',
      claimStatus: 'CLAIMED',
      benefit: { kind: 'CREDITS', amount: 100 },
    },
  ],
};

/** 真·有可领项。 */
const CLAIMABLE = {
  shouldShowCampaignPopup: false,
  uid: 'u-test',
  showCampaign: true,
  claimable: true,
  campaignUrl: 'https://gateway.qoder.com.cn/growth-page/activity-iframe',
  campaigns: [
    {
      campaignId: '01a1bbe5-a108-7c04-90e9-a6ae2f2123cc',
      campaignKey: 'act-20261109-678',
      actionType: 'CLAIM_BENEFIT',
      claimStatus: 'CLAIMABLE',
      benefit: { kind: 'CREDITS', amount: 100, validity: { mode: 'RELATIVE_DAYS', days: 30 } },
    },
  ],
};

const CLAIM_OK = {
  grantId: '01a1d876-a9c1-7c85-b234-7ab8d9edbe40',
  status: 'CLAIMED',
  replayed: false,
  benefit: { kind: 'CREDITS', amount: 100 },
  campaignId: '01a1bbe5-a108-7c04-90e9-a6ae2f2123cc',
  claimedAt: '2026-11-14T05:10:17Z',
};

// ---- 1. 必需请求头 ----
console.log('--- 1. 请求头（缺 cosy-clienttype 上游就不认）---');
reset();
plan = { [CAMPAIGNS_PATH]: [EMPTY_NO_SIGNAL] };
await usage.getCheckinStatus(account);
check('每次 /sash 请求都带 cosy-clienttype', headersSeen.every((h) => h['cosy-clienttype'] === '10'), true);
check('值必须是 10（1/99 都不行）', headersSeen[0]['cosy-clienttype'], '10');
check('Authorization 仍然在', String(headersSeen[0].Authorization || '').startsWith('Bearer dt-'), true);

// ---- 2. 空数组 + 无正面信号：不能记 already ----
console.log('\n--- 2. 空数组且无 claimable 信号 → error（不是 already）---');
reset();
plan = { [CAMPAIGNS_PATH]: [EMPTY_NO_SIGNAL] };
let record = await usage.claimCheckin(account);
check('记 error 而不是 already', record.status, 'error');
check('message 说明「可能未被识别」', /未被识别/.test(record.message), true);
check('标成可重试（给调度器多几档机会）', record.transient, true);
check('没有盲发 claim POST', calls.some((c) => c.method === 'POST' && c.pathname.includes('/claim')), false);

// ---- 3. 空数组 + showCampaign/claimable 有信号：这才是真·已领 ----
console.log('\n--- 3. 上游明确说「没有可领项」→ already ---');
reset();
plan = { [CAMPAIGNS_PATH]: [ALREADY] };
record = await usage.claimCheckin(account);
check('记 already', record.status, 'already');
check('不标可重试', record.transient, false);
check('没发 claim', calls.some((c) => c.method === 'POST' && c.pathname.includes('/claim')), false);

// ---- 4. 有可领项：真发 claim ----
//
// 用**另一个账号**跑：本地记录是按 account.id 存的，第 3 组已经把默认账号写成
// `already`，第 4 组要在「本地还没有当天记录」的状态下验证真实领取。
console.log('\n--- 4. 有可领项 → 发 claim 并记 checked ---');
reset();
const freshAccount = {
  ...accounts.addAccount({ channelId: 'qoder', idPrefix: 'qd', credential: baseCredential, label: '测试号2' }),
};
freshAccount.credential = baseCredential;
plan = {
  [CAMPAIGNS_PATH]: [CLAIMABLE],
  [`${CAMPAIGNS_PATH}/01a1bbe5-a108-7c04-90e9-a6ae2f2123cc/claim`]: [CLAIM_OK],
};
record = await usage.claimCheckin(freshAccount);
check('记 checked', record.status, 'checked');
check('积分来自 claim 响应', record.credits, 100);
check('发了 claim POST', calls.some((c) => c.method === 'POST' && c.pathname.endsWith('/claim')), true);
check('claim 用的 campaignId 正确', calls.find((c) => c.pathname.endsWith('/claim'))?.pathname, `${CAMPAIGNS_PATH}/01a1bbe5-a108-7c04-90e9-a6ae2f2123cc/claim`);

// ---- 5. 重复领取（replayed）也算 already，但不重复发放 ----
//
// 同样用干净账号：第 4 组刚写过一条 `checked`，而 `keepEarlierSuccess()` 会刻意
// 保留「当天已有的成功记录」不被后来的 already 覆盖——那是另一条规则，这里测的是
// replayed 分支本身。
console.log('\n--- 5. claim 返回 replayed: true → already ---');
reset();
const replayedAccount = {
  ...accounts.addAccount({ channelId: 'qoder', idPrefix: 'qd', credential: baseCredential, label: '测试号3' }),
};
replayedAccount.credential = baseCredential;
plan = {
  [CAMPAIGNS_PATH]: [CLAIMABLE],
  [`${CAMPAIGNS_PATH}/01a1bbe5-a108-7c04-90e9-a6ae2f2123cc/claim`]: [{ ...CLAIM_OK, replayed: true }],
};
record = await usage.claimCheckin(replayedAccount);
check('记 already', record.status, 'already');
check('message 说明已领过', /已经领过/.test(record.message), true);

// ---- 6. 本地已 checked 时不再发请求（幂等）----
//
// 先手动把本地状态写成「今天 checked」：第 5 组的 replayed 分支把记录写成了 `already`，
// 而幂等短路只认 `checked`（`already` 也要重新问一次上游——它可能是误解出来的）。
console.log('\n--- 6. 本地已 checked → 直接返回，不打上游 ---');
reset();
const store = await import('../src/core/checkin-store.ts');
const today = usageLocalDate();
store.writeCheckinState(account, {
  date: today,
  status: 'checked',
  credits: 100,
  extraCredits: 0,
  streakDays: null,
  message: '签到成功，获得 100 Credits',
  at: Date.now(),
});
record = await usage.claimCheckin(account);
check('记 already（沿用本地记录）', record.outcome, 'already');
check('积分沿用本地记录', record.credits, 100);
check('一个请求都没发', calls.length, 0);

// 先关库再删临时目录：Windows 上删不掉一个被打开的文件（EPERM）。
const { closeDb } = await import('../src/shared/db.ts');
closeDb();
fs.rmSync(tempData, { recursive: true, force: true });
console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
