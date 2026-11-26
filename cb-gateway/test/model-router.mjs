// 模型 id 的拼装/拆解、显示名、报错文案。纯函数，不碰磁盘也不碰上游。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, section, done } from './_helpers.mjs';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-model-router-'));
process.env.QB_DATA_DIR = tempData;

const router = await import('../src/core/router.ts');
const accounts = await import('../src/core/accounts.ts');

section('1. 拆 id');
const cases = [
  ['标准形状', 'wb-1/hy4free', { prefix: 'wb', seq: 1, modelId: 'hy4free' }],
  ['模型 id 带斜杠按第一个切', 'wb-2/vendor/model', { prefix: 'wb', seq: 2, modelId: 'vendor/model' }],
  ['序号多位数', 'wb-12/x', { prefix: 'wb', seq: 12, modelId: 'x' }],
  // 非法形状都返回 null
  ['没斜杠', 'hy4free', null],
  ['斜杠在头', '/hy4free', null],
  ['斜杠在尾', 'wb-1/', null],
  ['没序号', 'wb/x', null],
  ['序号 0', 'wb-0/x', null],
  ['前导零', 'wb-01/x', null],
  ['序号非数字', 'wb-a/x', null],
  ['非字符串', 42, null],
];
for (const [name, input, expected] of cases) check(name, router.parseModelId(input), expected);

section('2. 对外 id 能被拆回去');
const roundTrip = (accountId, upstreamId) => {
  const parsed = router.parseModelId(router.externalModelId({ id: accountId }, upstreamId));
  return parsed ? `${parsed.prefix}-${parsed.seq}/${parsed.modelId}` : null;
};
check('带点模型名', roundTrip('wb-1', 'deepseek-v4.1-flash'), 'wb-1/deepseek-v4.1-flash');
check('中划线模型名', roundTrip('tr-1', 'glm-5.3-flash'), 'tr-1/glm-5.3-flash');

section('3. 显示名');
const account = { id: 'wb-1', label: '账号1' };
check('账号 id + 模型名 + 倍率', router.modelDisplayName(account, 'Hy4 · 0.00x'), 'wb-1/Hy4 · 0.00x');
check('没倍率不加', router.modelDisplayName(account, 'Auto'), 'wb-1/Auto');
// 显示名只用账号 id，不看 label——label 是给人改的别名，改了不该让 DSH 模型名跟着变
check('改 label 不影响', router.modelDisplayName({ id: 'wb-1', label: '示例' }, 'Hy4'), 'wb-1/Hy4');
check('方括号被去掉', router.modelDisplayName(account, 'A]B[C'), 'wb-1/ABC');

section('4. 报错文案');
accounts.loadAccounts();
check('旧格式给新写法', router.unknownModelMessage('workbuddy/hy4free').includes('wb-1/hy4free'), true);
accounts.addAccount({ channelId: 'workbuddy', idPrefix: 'wb', credential: {} });
check('账号在模型不在', router.unknownModelMessage('wb-1/nope').includes('没有模型'), true);
check('能解析出账号', router.resolveModel('wb-1/hy4free')?.account.id, 'wb-1');
check('账号不存在返回 null', router.resolveModel('wb-9/x'), null);

const { closeDb } = await import('../src/shared/db.ts');
closeDb();
fs.rmSync(tempData, { recursive: true, force: true });
done();
