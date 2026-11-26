// 模型可见性（`channel_visibility` 表）的读写。守护「改了可见性但 DSH 没变」这类静默错。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, done } from './_helpers.mjs';

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-gw-visibility-'));
process.env.QB_DATA_DIR = tempData;

const vis = await import('../src/shared/model-visibility.ts');
const { db, closeDb } = await import('../src/shared/db.ts');
const rows = () => db.prepare('SELECT channel_prefix, listed, models FROM channel_visibility ORDER BY channel_prefix').all();
const MODELS = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];
const ids = () => vis.filterModels('workbuddy', MODELS).map((m) => m.id);

// 没配置 = 全部显示，且不编默认行
check('没配置全显示', ids(), ['a', 'b', 'c']);
check('没配置表为空', rows(), []);

// 保存清单：按清单顺序过滤，上游已没有的 id 丢掉
vis.setVisibleFor('workbuddy', ['c', 'a', 'ghost']);
check('按清单顺序', ids(), ['c', 'a']);
check('库里存 JSON 数组', JSON.parse(rows()[0].models), ['c', 'a', 'ghost']);

// 空数组 = 一个都不显示（≠ 没配置）
vis.setVisibleFor('workbuddy', []);
check('空数组全不显示', ids(), []);

// null = 删限制
vis.setVisibleFor('workbuddy', null);
check('删限制恢复全部', ids(), ['a', 'b', 'c']);

// 去重 + 非字符串
vis.setVisibleFor('trae', ['a', 'a', 'b', '', 42]);
check('去重且丢非字符串', vis.visibleFor('trae'), ['a', 'b']);

// 通道总闸
vis.setListed('workbuddy', false);
check('关闸不列模型', ids(), []);
check('关闸不影响别的通道', vis.isListed('trae'), true);
vis.setListed('workbuddy', true);
check('开闸恢复', ids(), ['a', 'b', 'c']);

// 总闸关、清单在：开闸应该留清单
vis.setVisibleFor('qoder', ['b']);
vis.setListed('qoder', false);
vis.setListed('qoder', true);
check('开闸不清清单', vis.visibleFor('qoder'), ['b']);

// 索引缓存两处静默风险：写完立即生效 + 返回值不被就地改污染
vis.setVisibleFor('loomy', ['x', 'y']);
check('写后立刻可读', vis.visibleFor('loomy'), ['x', 'y']);
const borrowed = vis.visibleFor('loomy');
borrowed.push('ghost');
check('就地改不污染缓存', vis.visibleFor('loomy'), ['x', 'y']);
vis.setListed('loomy', false);
check('关闸后清单没被污染', vis.visibleFor('loomy'), ['x', 'y']);
vis.setListed('loomy', true);
vis.setVisibleFor('loomy', null);
check('清清单立刻生效', vis.visibleFor('loomy'), null);

closeDb();
fs.rmSync(tempData, { recursive: true, force: true });
done();
