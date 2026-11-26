// 端到端：真起网关，验证「层分界」——前端产物公开、/api 要凭据、/v1 只认 Bearer、旧页面层已删。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, done } from './_helpers.mjs';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-e2e-'));
process.env.QB_DATA_DIR = tempData;
process.env.QB_HOST = '127.0.0.1';
process.env.QB_PORT = '7899';
fs.mkdirSync(path.join(tempData, 'auth'), { recursive: true });
fs.writeFileSync(path.join(tempData, 'config.json'), JSON.stringify({ verbose: false }));

const auth = await import('../src/shared/gateway-auth.ts');
const keys = await import('../src/core/keys.ts');
auth.loadCredential();
auth.changePassword('admin', 'probe-123456');
const { secret } = keys.createKey('e2e 测试');

const accounts = await import('../src/core/accounts.ts');
accounts.loadAccounts();
const demo = accounts.addAccount({ channelId: 'workbuddy', idPrefix: 'wb', credential: { accessToken: 'fake' }, label: '测试号' });
const traeDemo = accounts.addAccount({ channelId: 'trae', idPrefix: 'tr', credential: { token: 'fake', selfDeviceId: '2222222222222222', checkinDeviceId: '' }, label: 'Trae 测试号' });

const base = 'http://127.0.0.1:7899';
await import('../src/index.ts');
for (let i = 0; i < 60; i += 1) {
  try { if ((await fetch(base + '/')).status > 0) break; } catch { await new Promise((r) => setTimeout(r, 200)); }
}
const bearer = { authorization: 'Bearer ' + secret };

// ---- 1. 前端产物：公开、可缓存、深链接回壳 ----
const shellRes = await fetch(base + '/');
check('GET / → 200', shellRes.status, 200);
check('壳是 HTML', (shellRes.headers.get('content-type') || '').includes('text/html'));
check('壳 no-cache', shellRes.headers.get('cache-control'), 'no-cache');
const shell = await shellRes.text();
check('壳有 #app 挂载点', shell.includes('id="app"'));
check('壳不含 SSR 内容', shell.includes('<h1>'), false);

const assetPath = /src="(\/assets\/[^"]+\.js)"/u.exec(shell)?.[1];
check('壳引用带哈希产物', typeof assetPath, 'string');
const assetRes = await fetch(base + (assetPath || '/assets/nope.js'));
check('静态资源 200', assetRes.status, 200);
check('静态资源长缓存', assetRes.headers.get('cache-control'), 'public, max-age=31536000, immutable');

for (const route of ['/accounts', '/accounts/wb-1', '/login', '/password', '/no-such-page']) {
  const body = await (await fetch(base + route)).text();
  check(`深链接 ${route} → 壳`, body.includes('id="app"'));
}

// ---- 2. 认证边界：/api 无凭据 401 JSON，/v1 只认 Bearer ----
for (const apiPath of ['/api/health', '/api/accounts', '/api/keys']) {
  const res = await fetch(base + apiPath);
  check(`${apiPath} 无凭据 → 401`, res.status, 401);
  check(`${apiPath} 401 是 JSON`, (res.headers.get('content-type') || '').includes('json'));
}
const v1NoAuth = await fetch(base + '/v1/models');
check('/v1/models 无凭据 → 401', v1NoAuth.status, 401);
check('/v1/models 401 是 JSON', (v1NoAuth.headers.get('content-type') || '').includes('json'));
check('/api/health 带 Bearer 200', (await fetch(base + '/api/health', { headers: bearer })).status, 200);
check('/v1/models 带 Bearer 200', (await fetch(base + '/v1/models', { headers: bearer })).status, 200);
check('未登录打开 / 不重定向', (await fetch(base + '/', { redirect: 'manual' })).status, 200);

// ---- 3. 会话 ----
check('密码错 → 401', (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'wrong' }) })).status, 401);
const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'probe-123456' }) });
check('登录 200', login.status, 200);
const setCookie = (login.headers.getSetCookie ? login.headers.getSetCookie() : []).join(';');
const cookie = /gw_session=[^;]+/u.exec(setCookie)?.[0];
check('种下会话 Cookie', typeof cookie, 'string');
check('登录后不要求改密', (await login.json()).mustChangePassword, false);
check('会话可访问 /api/health', (await fetch(base + '/api/health', { headers: { cookie } })).status, 200);

check('/api/usage/hourly 缺 date → 400', (await fetch(base + '/api/usage/hourly', { headers: { cookie } })).status, 400);
check('/api/usage/hourly 非法日期 → 400', (await fetch(base + '/api/usage/hourly?date=2026-02-30', { headers: { cookie } })).status, 400);

check('退出 200', (await fetch(base + '/api/logout', { method: 'POST', headers: { cookie } })).status, 200);
check('退出后会话失效', (await fetch(base + '/api/health', { headers: { cookie } })).status, 401);
check('退出幂等', (await fetch(base + '/api/logout', { method: 'POST', headers: { cookie } })).status, 200);

// ---- 4. 旧页面层必须消失（表单动作 404）----
for (const [method, legacyPath] of [
  ['POST', '/login'], ['POST', '/password'], ['POST', `/accounts/${demo.id}/toggle`],
  ['POST', `/accounts/${demo.id}/label`], ['POST', `/accounts/${demo.id}/rotate-device`],
  ['POST', '/checkin/all'], ['POST', '/settings/checkin'], ['POST', '/keys'], ['POST', '/models'],
]) {
  check(`${method} ${legacyPath} → 404`, (await fetch(base + legacyPath, { method, headers: { cookie: cookie || '' }, body: '' })).status, 404);
}
check('未知 API → 404 JSON', (await fetch(base + '/api/nope', { headers: bearer })).status, 404);
check('未知页面 → 壳', (await fetch(base + '/nope')).status, 200);

// ---- 5. 账号动作 ----
check('改名生效', (await (await fetch(base + `/api/accounts/${demo.id}`, { method: 'PATCH', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ label: '改名了' }) })).json()).account.label, '改名了');
check('停用生效', (await (await fetch(base + `/api/accounts/${demo.id}`, { method: 'PATCH', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'disabled' }) })).json()).account.status, 'disabled');
check('不能手动设 cooldown', (await fetch(base + `/api/accounts/${demo.id}`, { method: 'PATCH', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'cooldown' }) })).status, 400);

const accountsApi = await (await fetch(base + '/api/accounts', { headers: bearer })).json();
check('/api/accounts 带能力位', ['canLogin', 'canLogout', 'canRotateDevice', 'canVerify', 'opensWindow'].every((k) => typeof accountsApi.channels[0][k] === 'boolean'));
// 表单式通道（loginMode=form）不该开空白窗。**不写死通道清单**——从通道注册表动态取。
const { channels: registeredChannels } = await import('../src/channels/index.ts');
const formChannels = registeredChannels.filter((c) => c.loginMode === 'form').map((c) => c.id).sort();
check('表单式通道不开空白窗', accountsApi.channels.filter((c) => c.opensWindow === false).map((c) => c.id).sort(), formChannels);

check('刷新积分：账号不存在 → 404', (await fetch(base + '/api/accounts/nope/credits', { method: 'POST', headers: bearer })).status, 404);
check('刷新积分：通道不存在 → 404', (await fetch(base + '/api/channels/nope/credits', { method: 'POST', headers: bearer })).status, 404);

const beforeRotate = accounts.getAccount(traeDemo.id).credential.selfDeviceId;
check('换设备号 changed=true', (await (await fetch(base + `/api/accounts/${traeDemo.id}/rotate-device`, { method: 'POST', headers: bearer })).json()).changed, true);
const afterRotate = accounts.getAccount(traeDemo.id).credential.selfDeviceId;
check('换号后变了', afterRotate !== beforeRotate, true);
check('换号不丢 token', accounts.getAccount(traeDemo.id).credential.token, 'fake');
check('检测失败也规整（200/502）', [200, 502].includes((await fetch(base + `/api/accounts/${demo.id}/verify`, { method: 'POST', headers: bearer })).status), true);

// ---- 6. 模型与可见性 ----
const v1Models = await (await fetch(base + '/v1/models', { headers: bearer })).json();
const apiModels = await (await fetch(base + '/api/models', { headers: bearer })).json();
check('/api/models 与 /v1/models 一致', JSON.stringify(apiModels), JSON.stringify(v1Models));
check('关掉通道总闸', (await (await fetch(base + '/api/models/visibility', { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ prefix: 'wb', action: 'toggle-list', listed: false }) })).json()).listed, false);
check('恢复全部显示', (await (await fetch(base + '/api/models/visibility', { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ prefix: 'wb', action: 'all' }) })).json()).listed, true);

// ---- 7. 签到与配置 ----
check('一键签到返回逐账号结果', Array.isArray((await (await fetch(base + '/api/checkin/all', { method: 'POST', headers: bearer })).json()).results), true);
check('手动领取返回 JSON', (await fetch(base + `/api/accounts/${demo.id}/checkin`, { method: 'POST', headers: bearer })).status, 200);
const checkinLog = await import('../src/core/checkin-log.ts');
const entries = checkinLog.readCheckinLog();
check('手动领取写了日志', entries.length >= 1);
check('日志来源 manual', entries[0].source, 'manual');
check('签到日志接口可读', (await fetch(base + '/api/checkin/log', { headers: bearer })).status, 200);
check('签到时间保存', (await (await fetch(base + '/api/config', { method: 'PATCH', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ checkinTime: '07:15' }) })).json()).checkinTime, '07:15');
check('非法签到时间被拒', (await fetch(base + '/api/config', { method: 'PATCH', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ checkinTime: '25:00' }) })).status, 400);

// ---- 8. 元信息 ----
const health = await (await fetch(base + '/api/health', { headers: bearer })).json();
check('/api/health ok', health.ok, true);
check('/api/health 通道数与注册表一致', Object.keys(health.channels).length, registeredChannels.length);
check('/api/channels 给外观', Array.isArray((await (await fetch(base + '/api/channels', { headers: bearer })).json()).channels), true);

// ---- 9. 删账号 ----
check('删除账号', (await fetch(base + `/api/accounts/${traeDemo.id}`, { method: 'DELETE', headers: bearer })).status, 200);
check('删完再查 404', (await fetch(base + `/api/accounts/${traeDemo.id}`, { headers: bearer })).status, 404);
check('删不存在 404', (await fetch(base + `/api/accounts/${traeDemo.id}`, { method: 'DELETE', headers: bearer })).status, 404);

// 起了 HTTP server，`done()` 只设 exitCode 不会让它退出——这里显式关库后强退。
const { closeDb } = await import('../src/shared/db.ts');
closeDb();
const failures = done();
process.exit(failures);

