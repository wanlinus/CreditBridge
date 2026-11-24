// 配置加载与**唯一的写入口**。`data/config.json` 可选、用户可手改，缺键就用默认值。
// **一个文件只能有一个写入口**：早先 `model-visibility.ts` 也现读现写，两个模块各做 read-modify-write，谁后写谁赢
// 且不报错——保存可见性后再改签到时间，可见性整段消失，被隐藏的模型全部重新冒出来。

import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from './types.ts';
import { DATA_DIR } from './shared/paths.ts';
import { writeFileAtomic } from './shared/atomic-write.ts';

const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

const DEFAULTS = {
  host: '127.0.0.1',
  port: 7801,
  // 客户端版本号串**不在这里**：它们属于「通道自述」，各通道在自己的 `identity` 里声明（见 `ChannelIdentity`）。
  // 放这里曾导致 Trae 只能写死版本号——写死的那个已经烂过一次（3.4.15 对上 1.107.1），表现成 401「Device proof required」。
  defaultContextWindow: 200000,
  defaultMaxTokens: 32768,
  verbose: true,
  // 每天定时签到的时间点，`HH:MM` 本地时间。**10:05 而不是 09:00**：Qoder 的签到活动每天北京时间 **10:00 才开新窗口**
  // （到次日 09:59 截止）。早先默认 09:00，等于每次都在窗口开启前一小时去领，那时 `campaigns` 是空数组，于是
  // **每一天都记成「当前没有可领取的签到活动」**（从 11-11 起签到日志里 qd-1 的 10 次尝试全是 `already`）。
  checkinTime: '10:05',
};

/**
 * 允许从 `config.json` 读的键。**`host` / `port` 故意不在其中**：容器部署时那个文件在卷里、
 * 镜像无法预设，靠它配置等于「我这边好好的、别人拉镜像起不来」。这两个只认 `QB_HOST` / `QB_PORT`。
 */
const FILE_KEYS = ['checkinTime', 'defaultContextWindow', 'defaultMaxTokens', 'verbose'] as const;

export type ConfigDoc = Record<string, any>;

function isPlainObject(value: unknown): value is ConfigDoc {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 磁盘上的原始文档，**不叠默认值**。文件不存在、JSON 坏了、顶层不是对象，一律当空文档：本机工具配置读不出来该退回默认值继续跑，而不是让网关起不来。 */
export function readConfigDoc(): ConfigDoc {
  try {
    const doc = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return isPlainObject(doc) ? doc : {};
  } catch {
    return {};
  }
}

/**
 * 生效配置。优先级：`QB_HOST` / `QB_PORT` 环境变量 > `config.json`（仅 `FILE_KEYS`）> 内置默认值。
 *
 * `config.json` 里如果还留着 `host` / `port`，**会被忽略**——不报错，因为那是历史残留，
 * 让人起来比报错更有用。
 */
function loadConfig(): AppConfig {
  const doc = readConfigDoc();
  const merged = { ...DEFAULTS };
  for (const key of FILE_KEYS) {
    if (doc[key] !== undefined) (merged as Record<string, unknown>)[key] = doc[key];
  }
  const envHost = (process.env.QB_HOST || '').trim();
  if (envHost) merged.host = envHost;
  const envPort = Number(process.env.QB_PORT);
  if (Number.isInteger(envPort) && envPort > 0 && envPort < 65536) merged.port = envPort;
  return merged;
}

/** 生效配置（内存副本）。运行期可变的项由 `updateConfig()` 原地更新。 */
export const config = loadConfig();

/** 读-改-写 `config.json`，**全项目唯一的写入口**。`mutator` 直接修改传进来的文档（可以删键）。只写回磁盘原始内容 + mutator 的改动，**不把默认值灌进文件**——文件是用户手改的入口，塞满默认值分不清「显式配了」和「没配」。写入是原子的。 */
export function mutateConfig(mutator: (doc: ConfigDoc) => void): void {
  const doc = readConfigDoc();
  mutator(doc);
  // `host` / `port` 只认环境变量，不写回文件：写回去会让人以为改那个文件有用。
  delete doc.host;
  delete doc.port;
  writeFileAtomic(CONFIG_PATH, `${JSON.stringify(doc, null, 2)}\n`);
}

/** 校验一个 `HH:MM` 字符串，合法返回 `true`。只认 24 小时制。 */
export function isValidCheckinTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(value);
  if (!match) return false;
  return true;
}

/** 写回配置并原地更新内存对象。只接受白名单里的键——别让「保存签到时间」的表单顺带把 host/port 也改掉（那两项改完必须重启，静默更新会造成「改了没反应」）。 */
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
