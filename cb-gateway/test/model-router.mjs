import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-model-router-'));
process.env.QB_DATA_DIR = tempData;

const router = await import('../src/core/router.ts');
const accounts = await import('../src/core/accounts.ts');

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

check('标准形状', router.parseModelId('wb-1/hy4free'), { prefix: 'wb', seq: 1, modelId: 'hy4free' });
check('模型 id 里带斜杠时按第一个切', router.parseModelId('wb-2/vendor/model'), { prefix: 'wb', seq: 2, modelId: 'vendor/model' });
check('序号可以多位数', router.parseModelId('wb-12/x'), { prefix: 'wb', seq: 12, modelId: 'x' });
check('没有斜杠 → null', router.parseModelId('hy4free'), null);
check('斜杠在开头 → null', router.parseModelId('/hy4free'), null);
check('斜杠在结尾 → null', router.parseModelId('wb-1/'), null);
check('没有序号 → null', router.parseModelId('wb/x'), null);
check('序号是 0 → null', router.parseModelId('wb-0/x'), null);
check('序号带前导零 → null（同一个号只能有一种写法）', router.parseModelId('wb-01/x'), null);
check('序号不是数字 → null', router.parseModelId('wb-a/x'), null);
check('非字符串 → null', router.parseModelId(42), null);

check('对外 id', router.externalModelId({ id: 'wb-3' }, 'glm-5.3'), 'wb-3/glm-5.3');

const roundTrip = (accountId, upstreamId) => {
  const external = router.externalModelId({ id: accountId }, upstreamId);
  const parsed = router.parseModelId(external);
  return parsed ? { prefix: parsed.prefix, account: `${parsed.prefix}-${parsed.seq}`, upstreamId: parsed.modelId } : null;
};
check(
  '对外 id 能拆回账号与上游 id',
  roundTrip('wb-1', 'deepseek-v4.1-flash'),
  { prefix: 'wb', account: 'wb-1', upstreamId: 'deepseek-v4.1-flash' },
);
check(
  '带点的模型名不受影响',
  roundTrip('tr-1', 'glm-5.3-flash'),
  { prefix: 'tr', account: 'tr-1', upstreamId: 'glm-5.3-flash' },
);

const channel = { id: 'workbuddy', idPrefix: 'wb', label: 'WorkBuddy' };
const account = { id: 'wb-1', label: '账号1' };
check('账号 id + 模型名 + 倍率', router.modelDisplayName(account, 'Hy4 · 0.00x'), 'wb-1/Hy4 · 0.00x');
check('没有倍率就不加', router.modelDisplayName(account, 'Auto'), 'wb-1/Auto');
check(
  '名字里自带 · 时按最后一个切',
  router.modelDisplayName(account, '某模型 · 0.5x · beta'),
  'wb-1/某模型 · 0.5x · beta',
);
check('改 label 不影响名字', router.modelDisplayName({ id: 'wb-1', label: '示例账号' }, 'Hy4'), 'wb-1/Hy4');
check('label 为空也不影响', router.modelDisplayName({ id: 'wb-9', label: '' }, 'Hy4'), 'wb-9/Hy4');
check(
  '模型名里的方括号被去掉（单段名字里没有配对结构了）',
  router.modelDisplayName(account, 'A]B[C'),
  'wb-1/ABC',
);

accounts.loadAccounts();
check('空 id', router.unknownModelMessage('').includes('wb-1/hy4free'), true);
check('旧格式给出新写法', router.unknownModelMessage('workbuddy/hy4free').includes('wb-1/hy4free'), true);
check('未知短前缀列出可用的', router.unknownModelMessage('zz-1/x').includes('wb'), true);
const noAccount = router.unknownModelMessage('wb-7/x');
check('账号不存在时说明没这个号', noAccount.includes('wb-7'), true);

accounts.addAccount({ channelId: 'workbuddy', idPrefix: 'wb', credential: {} });
check('账号在但模型不对时的文案', router.unknownModelMessage('wb-1/nope').includes('没有模型'), true);
check('有账号时列出兄弟账号', router.unknownModelMessage('wb-9/x').includes('wb-1'), true);
check('能解析出通道和账号', router.resolveModel('wb-1/hy4free')?.account.id, 'wb-1');
check('账号不存在时解析返回 null', router.resolveModel('wb-9/x'), null);

fs.rmSync(tempData, { recursive: true, force: true });
console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
