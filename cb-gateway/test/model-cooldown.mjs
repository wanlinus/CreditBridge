import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-model-cd-'));
process.env.QB_DATA_DIR = tempData;

const cd = await import('../src/core/model-cooldown.ts');
const accounts = await import('../src/core/accounts.ts');
const { channels } = await import('../src/channels/index.ts');
const { createApp } = await import('../src/app.ts');
const keys = await import('../src/core/keys.ts');
const auth = await import('../src/shared/gateway-auth.ts');

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

console.log('--- 1. 存储本身 ---');
cd.resetModelCooldownsForTests();
check('空表时查不到', cd.modelCooldownOf('wb-1', 'hy4free'), null);

const until = Date.now() + 60_000;
cd.markModelCooldown('wb-1', 'hy4free', until, '上游说超频了');
const got = cd.modelCooldownOf('wb-1', 'hy4free');
check('记下之后能查到', got?.model, 'hy4free');
check('until 保留', got?.until, until);
check('message 保留', got?.message, '上游说超频了');
check('同账号别的模型不受影响', cd.modelCooldownOf('wb-1', 'glm-5.3'), null);
check('别的账号不受影响', cd.modelCooldownOf('wb-2', 'hy4free'), null);

console.log('--- 2. 过期自动失效 ---');
cd.markModelCooldown('wb-1', 'old-model', Date.now() - 1, null);
check('过期查不到', cd.modelCooldownOf('wb-1', 'old-model'), null);

console.log('--- 3. 反复 429 取更晚的 until，不缩短 ---');
cd.resetModelCooldownsForTests();
const early = Date.now() + 10_000;
const late = Date.now() + 600_000;
cd.markModelCooldown('wb-1', 'm', late, 'long');
const shortened = cd.markModelCooldown('wb-1', 'm', early, 'short');
check('更早的 until 不会覆盖更晚的', shortened.until, late);

console.log('--- 4. clear 解除 ---');
check('clear 返回 true', cd.clearModelCooldown('wb-1', 'm'), true);
check('解除后查不到', cd.modelCooldownOf('wb-1', 'm'), null);
check('再 clear 返回 false', cd.clearModelCooldown('wb-1', 'm'), false);

console.log('--- 5. list 按恢复时间升序 ---');
cd.resetModelCooldownsForTests();
cd.markModelCooldown('wb-1', 'b', Date.now() + 60_000, null);
cd.markModelCooldown('wb-1', 'a', Date.now() + 30_000, null);
check('list 升序', cd.listModelCooldowns('wb-1').map((x) => x.model), ['a', 'b']);

console.log('--- 6. 落盘：重启后还记得 ---');
const file = path.join(tempData, 'state', 'model-cooldown.json');
check('文件写出来了', fs.existsSync(file));
const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
check('文件里是 account → model → until', typeof stored['wb-1']?.a?.until, 'number');

console.log('--- 7. 路由：429 只封那个模型 ---');
cd.resetModelCooldownsForTests();
auth.loadCredential();
auth.changePassword('admin', 'probe-123456');
const { secret } = keys.createKey('模型冷却测试');
const bearer = { Authorization: `Bearer ${secret}`, 'content-type': 'application/json' };

accounts.loadAccounts();
const account = accounts.addAccount({ channelId: 'wb', idPrefix: 'wb', credential: { token: 'a' }, label: '一号' });

channels.splice(0, channels.length);
const calls = [];
const fake = {
  id: 'wb',
  idPrefix: 'wb',
  label: 'WorkBuddy',
  identity: { clientVersion: '1.0.0' },
  modelsOf: async () => [
    { id: 'flash', name: 'Flash' },
    { id: 'hy4', name: 'Hy4' },
  ],
  creditsOf: async () => ({ provider: 'wb', supported: true, totalRemain: 1 }),
  chatAs: async (acct, request) => {
    calls.push(request.body.model);
    if (request.body.model === 'flash') {
      const err = new Error('上游 429：使用量已超出频率限制');
      err.status = 429;
      err.code = 'workbuddy_429';
      throw err;
    }
    return { kind: 'json', status: 200, body: { ok: true } };
  },
};
channels.push(fake);

const app = createApp();
const post = (model) =>
  app.request('/v1/chat/completions', {
    method: 'POST',
    headers: bearer,
    body: JSON.stringify({ model, stream: false, messages: [] }),
  });

const first = await post(`${account.id}/flash`);
check('第一次 flash → 429', first.status, 429);
check('flash 被记进模型冷却', cd.modelCooldownOf(account.id, 'flash') !== null);
check('账号本身没被标成 cooldown', accounts.getAccount(account.id).status, 'ready');

const second = await post(`${account.id}/flash`);
check('再请求 flash → 429', second.status, 429);
const secondBody = await second.json();
check('提示里说明「换同账号其他模型可以继续用」', /换同账号的其他模型/u.test(secondBody.error.message));
check('code 是 model_cooldown', secondBody.error.code, 'model_cooldown');
check('被冷却的模型不再打上游', calls.filter((m) => m === 'flash').length, 1);

const other = await post(`${account.id}/hy4`);
check('**同账号的另一个模型照常能用**', other.status, 200);
check('另一个模型真的打到了上游', calls.includes('hy4'));

console.log('--- 8. 成功会解除冷却 ---');
cd.markModelCooldown(account.id, 'hy4', Date.now() + 60_000, '手动塞一个');
check('先确认塞进去了', cd.modelCooldownOf(account.id, 'hy4') !== null);
cd.clearModelCooldown(account.id, 'hy4');
const afterClear = await post(`${account.id}/hy4`);
check('解除后能请求', afterClear.status, 200);

console.log('--- 9. 非 429 仍然走账号状态机 ---');
fake.chatAs = async () => {
  const err = new Error('token 失效');
  err.status = 401;
  throw err;
};
const bad = await post(`${account.id}/hy4`);
check('401 → 401', bad.status, 401);
check('账号被标成 invalid', accounts.getAccount(account.id).status, 'invalid');

fs.rmSync(tempData, { recursive: true, force: true });
console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
