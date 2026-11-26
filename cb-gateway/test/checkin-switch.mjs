// 守护签到开关：关掉不自动签、跳过一次只留一条 skipped、手动不受开关限制、内存副本跟着变。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, section, done } from './_helpers.mjs';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-checkin-switch-'));
process.env.QB_DATA_DIR = tempData;

const scheduler = await import('../src/core/checkin-scheduler.ts');
const accounts = await import('../src/core/accounts.ts');
const switches = await import('../src/shared/checkin-switch.ts');
const checkinLog = await import('../src/core/checkin-log.ts');
const { channels } = await import('../src/channels/index.ts');
const { closeDb } = await import('../src/shared/db.ts');

channels.splice(0, channels.length);
accounts.loadAccounts();

const calls = [];
const fake = {
  id: 'fake',
  idPrefix: 'fk',
  label: 'Fake',
  checkinClaimOf: async (account) => {
    calls.push(account.id);
    return { date: new Date().toISOString().slice(0, 10), status: 'checked', credits: 1 };
  },
  lastCheckinOf: () => null,
};
channels.push(fake);

const fk1 = accounts.addAccount({ channelId: 'fake', idPrefix: 'fk', credential: {} });
const fk2 = accounts.addAccount({ channelId: 'fake', idPrefix: 'fk', credential: {} });
accounts.loadAccounts();

scheduler.setSchedulerHooksForTests({ retryDelayMs: 1, setTimeout: () => 0 });

const skippedLog = () => checkinLog.readCheckinLog().filter((r) => r.status === 'skipped');

section('1. 默认全开');
check('默认开', switches.checkinEnabledOfAccount(fk1.id), true);
check('账号对象上也是 true', accounts.getAccount(fk1.id)?.checkinEnabled, true);

section('2. 关掉一个号');
accounts.setAccountCheckinEnabled(fk2.id, false);
switches.resetCheckinSwitchCacheForTests();
calls.length = 0;
await scheduler.runOnce();
check('关掉的号没签', calls.includes(fk2.id), false);
check('另一个号照常签', calls.includes(fk1.id), true);
check('内存副本跟着变', accounts.getAccount(fk2.id)?.checkinEnabled, false);

section('3. skipped 日志');
let skipped = skippedLog();
check('留了一条 skipped', skipped.length, 1);
check('记的是关掉的那个号', skipped[0]?.account, fk2.id);
check('有原因', typeof skipped[0]?.message === 'string' && skipped[0].message.length > 0, true);
check('来源是 auto', skipped[0]?.source, 'auto');

calls.length = 0;
await scheduler.runOnce();
check('再跑一轮不重复记', skippedLog().length, 1);

section('4. 手动不受限');
calls.length = 0;
await scheduler.checkinAllAccounts();
check('手动签到了关掉的号', calls.includes(fk2.id), true);

section('5. 重新打开');
accounts.setAccountCheckinEnabled(fk2.id, true);
switches.resetCheckinSwitchCacheForTests();
calls.length = 0;
await scheduler.runOnce();
check('恢复后自动签', calls.includes(fk2.id), true);

section('6. 边界');
check('不存在的账号返回 undefined', accounts.setAccountCheckinEnabled('nosuch-1', false) === undefined, true);
accounts.setAccountCheckinEnabled(fk1.id, true);
switches.resetCheckinSwitchCacheForTests();
check('重复设同一个值不报错', switches.checkinEnabledOfAccount(fk1.id), true);

closeDb();
fs.rmSync(tempData, { recursive: true, force: true });
done();
