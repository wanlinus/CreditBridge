// 进程级的两个常量：版本号、启动时间。
//
// 集中在这里是因为它们原先在两处各算一遍，而「模块加载那一刻」不同，同一个进程会
// 报出两个相差几十毫秒的 `startedAt`，看起来像两处数据不一致。
//
// 只给 ISO：**给人看的时间是前端的责任**（按用户时区格式化）。服务端一旦按自己的
// 时区拼好字符串，换个时区看就是错的。

import fs from 'node:fs';

/** `package.json` 的 `version`；读不到为 `null`（不影响运行，页面显示「—」）。 */
export const PACKAGE_VERSION: string | null = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || null;
  } catch {
    return null;
  }
})();

/** 进程启动时间。用 `process.uptime()` 倒推，比记模块加载时刻准。 */
export const STARTED_AT_MS = Date.now() - Math.round(process.uptime() * 1000);

/** 给程序看的 ISO 形式。 */
export const STARTED_AT_ISO = new Date(STARTED_AT_MS).toISOString();
