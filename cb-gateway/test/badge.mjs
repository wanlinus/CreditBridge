// 徽标（`GET /api/accounts/<id>/badge`）的「今日」口径。
//
// 钉的是「不报错只错数字」那一类：徽标和概览页各算各的「今天 0 点」，
// 在 UTC 进程里会差 8 小时——两个数都对得上类型检查，只是对不上彼此。
// 2026-11-26 就是这条路径在 CI（TZ=UTC）上把 `usage-daily` 干红 14 项，
// 而 `core/credits.ts` / `core/badge.ts` 当时还留着本地 `setHours(0,0,0,0)`。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, section, done } from './_helpers.mjs';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-gw-badge-'));
process.env.QB_DATA_DIR = tempData;

const { insertUsage } = await import('../src/store/usage.ts');
const { buildBadge } = await import('../src/core/badge.ts');
const { accountsWithSpend } = await import('../src/core/credits.ts');
const { loadAccounts, addAccount } = await import('../src/core/accounts.ts');
const { beijingMidnight, beijingToday } = await import('../src/shared/clock.ts');

loadAccounts();

// 造一个通道对象。徽标只需要 id / label / creditsOf 三样，其余不碰。
const channel = {
  id: 'workbuddy',
  idPrefix: 'wb',
  label: 'WorkBuddy',
  identity: { clientVersion: '1.0.0' },
  async creditsOf() {
    return { provider: 'workbuddy', supported: true, totalRemain: 42 };
  },
};

const account = addAccount({
  channelId: 'workbuddy',
  idPrefix: 'wb',
  credential: { accessToken: 'fake' },
  label: '徽标测试号',
});

// 北京时间今天 0 点，和「今天凌晨 1 点」「昨天 23 点」三个时刻。
const todayStart = beijingMidnight(beijingToday());
const EARLY_TODAY = todayStart + 3600000; // 北京今天 01:00 —— UTC 进程里可能还是昨天
const LATE_YESTERDAY = todayStart - 3600000; // 北京昨天 23:00

// 两条「今天」的记录 + 一条「昨天」的。跨不跨 UTC 日界取决于跑测试的时刻，
// 但**北京口径下**今天一定有 2 条、昨天一定有 1 条，这是断言的基础。
insertUsage({ ts: EARLY_TODAY, provider: 'workbuddy', account: account.id, model: 'm', promptTokens: 100, completionTokens: 10, status: 200 });
insertUsage({ ts: EARLY_TODAY + 1000, provider: 'workbuddy', account: account.id, model: 'm', promptTokens: 50, completionTokens: 5, status: 200 });
insertUsage({ ts: LATE_YESTERDAY, provider: 'workbuddy', account: account.id, model: 'm', promptTokens: 9999, completionTokens: 999, status: 200 });

section('1. 徽标的「今日」按北京时间切日，不是进程本地时间');
const badge = await buildBadge(channel, account);
// 今天两条：100+10 和 50+5 = 165 tok。若把昨天那条算进来会是 11163。
check('今日 token 只算北京今天的两条', badge.today, '今日 165 tok');
check('徽标主数字是余额', badge.amount, '42');

section('2. 账号列表的「今日」和徽标同口径');
const spend = await accountsWithSpend([account]);
check('accountsWithSpend 今日 token 与徽标一致', spend.tokensToday[account.id], 165);
// 30 天窗口包含昨天那条。
check('近 30 天窗口含昨天那条', spend.tokensTotal[account.id], 165 + 9999 + 999);

section('3. 时区边界：今天 0 点整算今天，前一毫秒算昨天');
insertUsage({ ts: todayStart, provider: 'workbuddy', account: account.id, model: 'm', promptTokens: 1000, completionTokens: 0, status: 200 });
insertUsage({ ts: todayStart - 1, provider: 'workbuddy', account: account.id, model: 'm', promptTokens: 2000, completionTokens: 0, status: 200 });
const afterBoundary = await accountsWithSpend([account]);
check('0 点整进今天、前一毫秒不进', afterBoundary.tokensToday[account.id], 165 + 1000);

done();
