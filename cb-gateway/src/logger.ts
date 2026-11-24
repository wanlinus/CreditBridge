// 控制台 + 滚动文件日志。所有模块都走这一个 `log`，通道内部的决策才能和所属请求行按时间顺序落在 data/logs 里。

import fs from 'node:fs';
import path from 'node:path';
import { LOG_DIR } from './shared/paths.ts';
import { localDate } from './shared/clock.ts';

/** 按天滚动的日志保留天数。一天几十到几百 KB，30 天后删掉，不然只会一直涨。 */
const RETENTION_DAYS = 30;

let verbose = true;

export function configureLogger(options: { verbose?: boolean } = {}) {
  if (typeof options.verbose === 'boolean') verbose = options.verbose;
}

/** 删掉超过保留期的按天日志。只碰 `gateway-YYYY-MM-DD.log` 这个模式：`logs/` 里还有插件写的 `plugin-host.log`、启动脚本重定向的 `gateway.out.log`，误删会让人查不到问题。 */
function pruneOldLogs() {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
  let names;
  try {
    names = fs.readdirSync(LOG_DIR);
  } catch {
    return; // 目录还不存在，第一次写入时会建
  }
  for (const name of names) {
    if (!/^gateway-\d{4}-\d{2}-\d{2}\.log$/u.test(name)) continue;
    const file = path.join(LOG_DIR, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) {
        fs.rmSync(file, { force: true });
        // 用 console 而不是 log()：此刻正在初始化日志本身，别递归。
        if (verbose) console.log(`[logger] 清理过期日志 ${name}`);
      }
    } catch {
      /* 单个文件删不掉就算了，下次启动再试 */
    }
  }
}

pruneOldLogs();

export function log(...args: unknown[]) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  if (verbose) console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    // **文件名用本地日期，不用 UTC**。早先写的是 `toISOString().slice(0, 10)`——那是 UTC 日期，容器
    // `TZ=Asia/Shanghai` 时早上 8 点前的日志全被写进「昨天」那个文件，而日志行的时间戳是本地 ISO：
    // 按日期找文件会找错、打开后时间戳又对不上。日志行本身保留 ISO（带 Z）不变，那是给机器解析的。
    const day = localDate();
    fs.appendFileSync(path.join(LOG_DIR, `gateway-${day}.log`), line + '\n');
  } catch {
    /* 日志绝不能把一次请求搞挂 */
  }
}
