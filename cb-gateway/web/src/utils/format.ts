/**
 * 数字与时间的格式约定。
 *
 * 三条别改：
 *   - `null` / 非有限 → `—`（**不是 `0`**）：「拉不到」和「真的是 0」是两种语义。
 *   - `fmtTime` 当年才省略年份，格式 `MM-DD HH:mm`。
 *   - `fmtAgo` 进页面算一次就固定，不要挂定时器（「刚刚」自己跳动是噪音）。
 */

/** 数字：千分位，最多 `digits` 位小数；非数字返回 `—`。 */
export function fmtNum(value: unknown, digits = 2): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

/** 时间：`MM-DD HH:mm`；不是今年的才带年份。 */
export function fmtTime(ts: unknown): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '—';
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  const pad = (n: number) => String(n).padStart(2, '0');
  const head = sameYear
    ? `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${head} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 相对时间：给「最后使用」这种地方用。 */
export function fmtAgo(ts: unknown): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '从未';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

/** `HH:mm`。冷却/签到这类「几点几分」的场合用。 */
export function fmtClock(ts: unknown): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 耗时：`1.2s` / `820ms`。账本里的 `durationMs` 用。 */
export function fmtDuration(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

/**
 * token 数量：`1.03 亿` / `5.3 万` / `820`。
 *
 * **为什么单独一个函数而不是直接用 `fmtNum`**：token 的量级跨得很开——一个账号一天
 * 几万、一个月上亿，用千分位写出来是 `103,214,553`，在表格里根本读不出量级，
 * 而这一列的核心信息就是量级。
 *
 * 阈值取 1 万 / 1 亿（中文习惯的四位一进），不是 1K/1M：界面全中文，混用两套进位
 * 会让人心算一次。
 *
 * `null` / 非有限 → `—`（和 `fmtNum` 同一条约定：**「拉不到」不是 0**）。
 */
export function fmtTokens(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(2)} 亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)} 万`;
  return fmtNum(value, 0);
}

/**
 * 人民币金额：`¥3.67` / `¥0.042`。
 *
 * **不能直接用 `fmtNum`**：token 折算出来的钱常常只有几分钱，两位小数会把它显示成
 * `¥0.00`——那等于说「不要钱」，而实际是要钱的。所以按量级给小数位。
 *
 * 非有限值 → `—`（和别处同一条约定）。
 */
export function fmtCny(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value === 0) return '¥0';
  if (value >= 1) return `¥${value.toFixed(2)}`;
  if (value >= 0.01) return `¥${value.toFixed(3)}`;
  // 小于 1 分时给 2 位有效数字，避免显示成 ¥0.0000
  return `¥${value.toPrecision(2)}`;
}

/**
 * 把**已经是比例**的数（`0.9898`）格式化成百分比：`99.0%`。
 *
 * ## 为什么只有这一个百分比函数
 *
 * 这里曾经还有一个 `fmtPercent(part, whole)`——收「分子分母」自己算。它**一个调用方
 * 都没有**，但它的存在本身是个陷阱：缓存命中率必须用服务端算好的那个率（已排除不报
 * 缓存的通道），前端拿 `cached / prompt` 相除会得出另一个数（84% vs 99%），那是两套
 * 口径打架。留着一个「自己相除」的工具，早晚有人拿它去算命中率。
 *
 * 所以删掉了。要显示百分比，就让服务端把率算好，这里只负责格式化。
 */
export function fmtRatio(value: unknown, digits = 1): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}
