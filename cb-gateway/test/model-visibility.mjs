import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-gw-visibility-'));
process.env.QB_DATA_DIR = tempData;

const vis = await import('../src/shared/model-visibility.ts');

const configPath = path.join(tempData, 'config.json');
const MODELS = [
  { id: 'a', name: 'A' },
  { id: 'b', name: 'B' },
  { id: 'c', name: 'C' },
];

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

check('没有 config.json 时不算有限制', vis.visibleFor('workbuddy'), null);
check('没限制时原样返回', vis.filterModels('workbuddy', MODELS).map((m) => m.id), ['a', 'b', 'c']);

fs.writeFileSync(configPath, JSON.stringify({ host: '0.0.0.0', port: 7801 }, null, 2));
vis.setVisibleFor('workbuddy', ['c', 'a', 'ghost']);
check('按清单顺序过滤', vis.filterModels('workbuddy', MODELS).map((m) => m.id), ['c', 'a']);
check('上游已经没有的 id 被丢掉，不报错', vis.filterModels('workbuddy', MODELS).length, 2);
const afterWrite = JSON.parse(fs.readFileSync(configPath, 'utf8'));
check('写回时保留了 host', afterWrite.host, '0.0.0.0');
check('写回时保留了 port', afterWrite.port, 7801);

vis.setVisibleFor('workbuddy', []);
check('空数组就是「一个都不显示」', vis.filterModels('workbuddy', MODELS).length, 0);
check('空数组仍算「有配置」', vis.visibleFor('workbuddy'), []);

vis.setVisibleFor('workbuddy', null);
check('删限制后恢复全部', vis.visibleFor('workbuddy'), null);
check(
  '删掉最后一个限制时连 visibleModels 键一起清掉',
  Object.prototype.hasOwnProperty.call(vis.visibleModels(), 'workbuddy'),
  false,
);
const afterReset = JSON.parse(fs.readFileSync(configPath, 'utf8'));
check('清掉限制不影响 host', afterReset.host, '0.0.0.0');
check('清掉限制后文件里没有空对象', Object.prototype.hasOwnProperty.call(afterReset, 'visibleModels'), false);

vis.setVisibleFor('trae', ['a', 'a', 'b', '', 42]);
check('重复 id 去重、非字符串丢掉', vis.visibleFor('trae'), ['a', 'b']);

fs.writeFileSync(configPath, '{ 这不是 JSON');
check('坏文件当作没限制，不抛异常', vis.visibleFor('trae'), null);
vis.setVisibleFor('trae', ['b']);
check('坏文件能被一次保存覆盖修好', vis.visibleFor('trae'), ['b']);

check('默认是打开的（缺键）', vis.isListed('workbuddy'), true);
vis.setListed('workbuddy', false);
check('关掉后 isListed 为 false', vis.isListed('workbuddy'), false);
check('关掉后模型列表一个都不回', vis.filterModels('workbuddy', MODELS).length, 0);
check('关掉时写进 visibleChannels', JSON.parse(fs.readFileSync(configPath, 'utf8')).visibleChannels.workbuddy, false);
check('关掉不影响别的通道', vis.isListed('trae'), true);
check('关掉不动 visibleModels', vis.visibleFor('trae'), ['b']);
vis.setListed('workbuddy', true);
const afterOn = JSON.parse(fs.readFileSync(configPath, 'utf8'));
check('打开后把键删掉而不是写 true', Object.prototype.hasOwnProperty.call(afterOn, 'visibleChannels'), false);
check('打开后模型列表恢复', vis.filterModels('workbuddy', MODELS).map((m) => m.id), ['a', 'b', 'c']);
fs.writeFileSync(configPath, '{ 坏了');
check('文件坏了当作打开', vis.isListed('trae'), true);

console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
