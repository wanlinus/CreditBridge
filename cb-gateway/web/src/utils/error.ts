/**
 * 把 `unknown` 的错误转成一句能给人看的话。
 *
 * ## 为什么值得单独一个文件
 *
 * 全量审查时这个表达式在 **10 个文件里出现了 14 次**
 * （`error instanceof Error ? error.message : String(error)`），
 * 另外还有两个本地 `errorText()` 和一个 `messageOf()` 各定义了一遍。
 *
 * 重复的代价不是行数，是**以后改不动**：比如要给网络错误加前缀、要把 `ApiError`
 * 的 `type` 也带出来，得逐个改十四处，漏掉的那处不会报错。
 */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
