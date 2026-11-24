// 本机日历日。签到按自然日算，用本地时区——容器里 `TZ=Asia/Shanghai`。

export function localDate(at: Date = new Date()): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

/** `21:35`。只给时分是有意的：冷却很少跨天，真跨天了消息里还有上游原文。 */
export function formatClock(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
