// 守护：`idempotent` 必须映射成 `already` 而非 `error`；`pc_version` 空时自己拦下，别去撞像 cookie 过期的 710010702。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, section, done } from './_helpers.mjs';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-dbcheckin-'));
process.env.QB_DATA_DIR = tempData;
fs.mkdirSync(path.join(tempData, 'auth'), { recursive: true });
fs.writeFileSync(path.join(tempData, 'config.json'), JSON.stringify({}));

const auth = await import('../src/channels/doubao/auth.ts');
const usage = await import('../src/channels/doubao/usage.ts');

section('1. 没凭据直接失败，不发请求');
auth.configureIdentity('2.38.7');
const record = await usage.claimCheckin({ id: 'db-x', channelId: 'doubao', credential: null });
check('status=error', record.status, 'error');
check('消息说明凭据', /凭据/.test(record.message || ''), true);
check('带 date 字段', /^\d{4}-\d{2}-\d{2}$/.test(record.date), true);

section('2. 版本号守卫排在凭据检查之前');
const src = fs.readFileSync(new URL('../src/channels/doubao/usage.ts', import.meta.url), 'utf8');
const fnBody = src.slice(src.indexOf('export async function claimCheckin'));
const guardIdx = fnBody.indexOf('if (!DOUBAO_VERSION)');
const credIdx = fnBody.indexOf('usableCredential(account');
check('版本号守卫存在', guardIdx > 0, true);
check('版本号守卫在凭据获取之前', guardIdx > 0 && credIdx > 0 && guardIdx < credIdx, true);

section('3. 本地记录读写');
const accounts = await import('../src/core/accounts.ts');
accounts.loadAccounts();
const account = accounts.addAccount({
  channelId: 'doubao', idPrefix: 'db',
  credential: { cookies: {}, deviceId: '1', webId: '0', uid: 'u', source: 'test' },
  label: '签到测试号',
});
check('新账号没有签到记录', usage.readLastCheckin(account), null);
const { writeCheckinState } = await import('../src/core/checkin-store.ts');
check('写入成功', writeCheckinState(account, { date: '2026-01-01', status: 'checked', credits: 200 }), true);
const back = usage.readLastCheckin(account);
check('写进去能读出来', back?.status, 'checked');
check('credits 保留', back?.credits, 200);

section('4. 源码层面的关键断言');
check('activity id 是 pc_incentive_task_mvp_v3', src.includes("'pc_incentive_task_mvp_v3'"), true);
check('接口路径正确', src.includes("'/alice/ug/campaign/landing/checkin'"), true);
check('认 idempotent 字段', src.includes('data.idempotent'), true);
check('idempotent 映射成 already', /idempotent === true[\s\S]{0,300}status: 'already'/.test(src), true);
check('有版本号守卫', /if \(!DOUBAO_VERSION\)/.test(src), true);
check('710010702 单独说明', src.includes('710010702'), true);
check('用了 writeCheckinState', src.includes('writeCheckinState'), true);
check('用了 keepEarlierSuccess（避免 already 覆盖真签到）', src.includes('keepEarlierSuccess'), true);
check('用 localDate()', src.includes('localDate('), true);
check('没有自己拼日期', /getFullYear\(\)/.test(src), false);

section('5. 通道接线 + 结构一致性');
const indexSrc = fs.readFileSync(new URL('../src/channels/doubao/index.ts', import.meta.url), 'utf8');
check('实现了 checkinClaimOf', /checkinClaimOf\(account\)/.test(indexSrc), true);
check('实现了 lastCheckinOf', /lastCheckinOf\(account\)/.test(indexSrc), true);
check('签到日志走 setUsageLogger', indexSrc.includes('setUsageLogger(log)'), true);

const files = fs.readdirSync(new URL('../src/channels/doubao/', import.meta.url)).filter((f) => f.endsWith('.ts')).sort();
const STANDARD = ['auth.ts', 'index.ts', 'login.ts', 'models.ts', 'upstream.ts', 'usage.ts'];
const HELPERS = ['passport.ts', 'risk-control.ts', 'verify-ways.ts'];
check('没有非标准文件', files.filter((f) => !STANDARD.includes(f) && !HELPERS.includes(f)), []);
check('标准文件齐全', STANDARD.filter((f) => !files.includes(f)), []);
check('没有独立 checkin.ts', files.includes('checkin.ts'), false);
check('没有 logger-types.ts', files.includes('logger-types.ts'), false);

done();
