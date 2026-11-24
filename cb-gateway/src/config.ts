// 配置加载与**唯一的写入口**。`data/config.json` 可选、用户可手改，缺键就用默认值。
//
// 这里只剩三项（`host` / `port` / `checkinTime`）：可见性和模型设置已经进库，因为
// 它们改完要立刻生效，而这三项改完得重启。生命周期不同，混在一个文件里只会让人以为
// 改可见性也要重启。
//
// **一个文件只能有一个写入口**：所有写盘都走 `mutateConfig()`（读原始文档 → 改 →
// 原子写）。早先 `model-visibility.ts` 也现读现写这个文件，两个模块各做 read-modify-write，
// 谁后写谁赢而且不报错——保存可见性后再改签到时间，可见性整段消失，被隐藏的模型
// 全部重新冒出来。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './shared/paths.ts';
import { writeFileAtomic } from './shared/atomic-write.ts';

const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

const DEFAULTS = {
  host: '127.0.0.1',
  port: 7801,
  // 客户端版本号串**不在这里**：它们属于「通道自述」，各通道在自己的 `identity`
  // 里声明（见 src/types.ts 的 ChannelIdentity）。放这里曾导致 WorkBuddy 的三个
  // 版本号占据公共结构，而 Trae 只能在自己的 auth 模块里写死——写死的那个已经
  // 烂过一次（3.4.15 对上 1.107.1），表现成 401「Device proof required」。
  defaultContextWindow: 200000,
  defaultMaxTokens: 32768,
  verbose: true,
  // 每天定时签到的时间点，`HH:MM` 本地时间。签到调度器读到这个点去签。
  //
  // **为什么是 10:05 而不是 09:00**：Qoder 的签到活动**每天北京时间 10:00 才开新窗口**
  // （到次日 09:59 截止，见 `channels/qoder/usage.ts`）。早先默认 09:00，等于每次都在
  // 窗口开启前一小时去领——那时上一轮刚结束、新一轮还没开始，`campaigns` 是空数组，
  // 于是**每一天都记成「当前没有可领取的签到活动」**，一次都没真正领到过。
  // 这个 bug 从 11-11 一直存在：签到日志里 qd-1 的 10 次尝试全是 `already`，
  // 而它上游的加购额度是 300（= 3×100，客户端手动领的），说明钱确实还在。
  //
  // 10:05 留了 5 分钟余量，避免上游窗口刚开时数据还没刷出来的边界情况。
  // 另外三个通道没有硬性时间窗（Loomy 每天 0 点重置、其余两个随时可签），
  // 所以统一往后推不会伤到它们。
  checkinTime: '10:05',
};

export type ConfigDoc = Record<string, any>;

function isPlainObject(value: unknown): value is ConfigDoc {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 磁盘上的原始文档，**不叠默认值**。
 *
 * 文件不存在、JSON 坏了、顶层不是对象，一律当空文档：这是本机工具，配置读不出来
 * 应该退回默认值继续跑，而不是让网关起不来。
 */
export function readConfigDoc(): ConfigDoc {
  try {
    const doc = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return isPlainObject(doc) ? doc : {};
  } catch {
    return {};
  }
}

function loadConfig() {
  return { ...DEFAULTS, ...readConfigDoc() };
}

/** 生效配置（内存副本）。运行期可变的项由 `updateConfig()` 原地更新。 */
export const config = loadConfig();

/**
 * 读-改-写 `config.json`。**全项目唯一的写入口。**
 *
 * `mutator` 直接修改传进来的文档（可以删键）。只写回磁盘上的原始内容 +
 * mutator 的改动，**不把默认值灌进文件**——文件是用户手改的入口，塞满默认值只会
 * 让它越来越吵，也分不清「显式配了」和「没配」。
 *
 * 写入是原子的（tmp + rename）：断电不会留下半截 JSON。
 */
export function mutateConfig(mutator: (doc: ConfigDoc) => void): void {
  const doc = readConfigDoc();
  mutator(doc);
  writeFileAtomic(CONFIG_PATH, `${JSON.stringify(doc, null, 2)}\n`);
}

/**
 * 校验一个 `HH:MM` 字符串，合法返回 `true`。只认 24 小时制。
 */
export function isValidCheckinTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(value);
  if (!match) return false;
  return true;
}

/**
 * 写回配置并原地更新内存对象。只接受白名单里的键——别让「保存签到时间」的表单
 * 顺带把 host/port 也改掉（那两项改完必须重启才生效，静默更新会造成「改了没反应」）。
 */
export function updateConfig(patch: Record<string, unknown>): { ok: boolean; error?: string } {
  const allowed = new Set(['checkinTime']);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) return { ok: false, error: `不允许改配置键 ${key}` };
  }
  if ('checkinTime' in patch && !isValidCheckinTime(patch.checkinTime)) {
    return { ok: false, error: '签到时间必须是 HH:MM（24 小时制）' };
  }
  try {
    mutateConfig((doc) => {
      Object.assign(doc, patch);
    });
  } catch (error: any) {
    return { ok: false, error: error?.message || '写配置失败' };
  }
  Object.assign(config, patch);
  return { ok: true };
}
