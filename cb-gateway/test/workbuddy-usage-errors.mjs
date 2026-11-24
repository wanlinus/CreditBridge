// WorkBuddy 余额接口的错误处理。
//
// 钉住 2026-11-22 发现的一个静默失败：`getWorkBuddyUsage()` 是四个通道里**唯一**
// 不检查 `response.ok` 的——它直接 `response.json()` 然后
// `doc?.data?.Response?.Data?.Accounts || []`。上游一抖（5xx），packages 变成空数组，
// `totalRemain` 算出 **0**，而 0 是合法数字：
//
//   core/credits.ts 的 readOne()：remain = typeof 0 === 'number' ? 0 : null → 0
//                                  if (remain !== null) creditsCache.set(...)   ← 缓存 30 秒
//                                  error: remain === null ? '...' : null        ← 不报错
//
// 表现是徽标显示「剩余 0」，看起来像额度用光了，实际只是上游抖了一下。另外三个通道
// 都在这里抛错，界面显示 `—` 并带上原因。
//
// 跑：node test/workbuddy-usage-errors.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-wb-usage-'));
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

const { getWorkBuddyUsage } = await import('../src/channels/workbuddy/usage.ts');

const account = {
  id: 'wb-9',
  channelId: 'workbuddy',
  status: 'ready',
  credential: {
    accessToken: 'fake-token',
    refreshToken: 'fake-refresh',
    expiresAt: Date.now() + 86400_000,
    uid: 'u-test',
    source: 'login',
  },
};

/** 让下一次请求回指定的状态码和 body。 */
let nextStatus = 200;
let nextBody = '';
globalThis.fetch = async () => ({
  ok: nextStatus >= 200 && nextStatus < 300,
  status: nextStatus,
  text: async () => nextBody,
});

async function run(status, body) {
  nextStatus = status;
  nextBody = body;
  try {
    return { credits: await getWorkBuddyUsage(account), error: null };
  } catch (error) {
    return { credits: null, error: error.message };
  }
}

// ---- 1. 上游 5xx 必须抛错，不能算出「剩余 0」 ----
console.log('--- 1. 上游 5xx ---');
let result = await run(500, '{"code":-1,"msg":"server exploded"}');
check('抛错而不是返回 0', result.credits === null);
check('错误信息带状态码', /HTTP 500/.test(result.error ?? ''));
check('错误信息带上游原文', /server exploded/.test(result.error ?? ''));

// 这条是本文件存在的理由：如果实现退回「不检查 ok」，上面那两条会同时失败。
result = await run(503, '{"code":-1,"msg":"upstream busy"}');
check('503 同样抛错', result.credits === null);

// ---- 2. HTTP 200 但业务码非 0：同样是失败 ----
console.log('\n--- 2. 业务码非 0 ---');
result = await run(200, '{"code":10086,"msg":"quota backend down"}');
check('业务码非 0 抛错', result.credits === null);
check('错误信息带业务码', /10086/.test(result.error ?? ''));

// ---- 3. 非 JSON 响应：不能静默当空 ----
console.log('\n--- 3. 非 JSON ---');
result = await run(200, '<html>502 Bad Gateway</html>');
check('非 JSON 抛错', result.credits === null);
check('错误信息说明不是 JSON', /非 JSON/.test(result.error ?? ''));

// ---- 4. 正常路径不受影响 ----
console.log('\n--- 4. 正常路径 ---');
result = await run(
  200,
  JSON.stringify({
    code: 0,
    data: {
      Response: {
        Data: {
          Accounts: [
            { PackageName: 'P1', CapacitySize: 100, CapacityRemain: 60, ExpiredTime: '2026-12-01 00:00:00' },
            { PackageName: 'P2', CapacitySize: 50, CapacityRemain: 25, ExpiredTime: '' },
          ],
        },
      },
    },
  }),
);
check('totalRemain 是两个包的剩余之和', result.credits?.totalRemain, 85);
check('packages 归一成 name/limit/used/expireAt', result.credits?.packages?.[0]?.name, 'P1');
check('used 由 limit - remain 派生', result.credits?.packages?.[0]?.used, 40);
check('expireAt 解析成时间戳', typeof result.credits?.packages?.[0]?.expireAt, 'number');

// 上游真的报「剩余 0」时，必须如实回 0 —— 「上游说 0」和「上游没说」是两件事，
// 这条防止修复过度把合法 0 也当成错误。
console.log('\n--- 5. 上游真的报 0（合法，不能当错误）---');
result = await run(
  200,
  JSON.stringify({ code: 0, data: { Response: { Data: { Accounts: [{ PackageName: 'P', CapacitySize: 100, CapacityRemain: 0 }] } } } }),
);
check('合法的 0 不抛错', result.error, null);
check('合法的 0 如实返回', result.credits?.totalRemain, 0);

// 先关库再删临时目录：Windows 上删不掉一个被打开的文件（EPERM）。
const { closeDb } = await import('../src/shared/db.ts');
closeDb();
fs.rmSync(tempData, { recursive: true, force: true });
console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
