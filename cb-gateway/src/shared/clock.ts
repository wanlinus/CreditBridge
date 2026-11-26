// 日历与时区工具。
//
// **两种时间口径必须分开**：
//
// - `localDate()` / `formatClock()` 是给**人看的**（签到日期、冷却提示），
//   用进程本地时区就够——容器里 `TZ=Asia/Shanghai`。
// - `beijingHour()` / `beijingWeekday()` 是**业务规则**：峰谷计价按北京时间算。
//   它不能看进程 `TZ`——2026-11-25 踩过，本地 UTC+8、CI 是 UTC，
//   按本地时间判峰谷会让结果全反（59 项测试失败 15 项）。

/** 本机日历日 `YYYY-MM-DD`。给人看的日期用这个。 */
export function localDate(at: Date = new Date()): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

/** `21:35`。只给时分是有意的：冷却很少跨天，真跨天了消息里还有上游原文。 */
export function formatClock(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 北京时间的小时（0-23）。**不看进程 `TZ`**，峰谷计价要靠它。 */
export function beijingHour(at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date(at));
  // `hour12: false` 在午夜会给出 "24"，统一成 0。
  return Number(parts.find((part) => part.type === 'hour')?.value ?? '0') % 24;
}

/** 北京时间的星期几（0 = 周日 … 6 = 周六）。**不看进程 `TZ`**。 */
export function beijingWeekday(at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
  }).formatToParts(new Date(at));
  const name = parts.find((part) => part.type === 'weekday')?.value ?? '';
  const order = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const index = order.indexOf(name);
  return index >= 0 ? index : 0;
}

/** 北京时间的今天 `YYYY-MM-DD`。**不看进程 `TZ`**——账本按北京日分桶。 */
export function beijingToday(at: number = Date.now()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(at));
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

/**
 * 把 `YYYY-MM-DD` 解析成**北京时间**那天的 0 点（毫秒）。
 *
 * 上海没有夏令时，UTC+8 恒定，所以直接 `Date.UTC(y, m-1, d) - 8h`，不经过
 * `Intl`（CI 的 small-icu 可能缺 locale 数据）也不经过进程 `TZ`。
 */
export function beijingMidnight(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`date 要是 YYYY-MM-DD：${date}`);
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return utc - 8 * 3600000;
}

/**
 * 毫秒时间戳 → 北京时间的 `YYYY-MM-DD`。**不看进程 `TZ`**、不依赖 `Intl` locale。
 *
 * 账本分桶（`+8 hours`）和日期 key 都走这条路，两边必须同一个口径，否则「今天」
 * 的边界在 UTC 进程里会差一天。
 */
export function beijingDate(at: number): string {
  const shifted = new Date(at + 8 * 3600000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}
