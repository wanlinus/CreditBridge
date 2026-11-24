// 编辑 profile YAML 的**行级**工具。一律按行改，不做 YAML 序列化往返——
// 往返会把注释、引号风格、键顺序全部重排，人写的配置几次就没法看了。
//
// 两个文件共用（`index.js` 的 writeProvider、`profile-models.js` 的 models 段）。
// 早先各写一份，`index.js` 那份漏了 `providerAbove` / `blockEnd`，而测试的桩把它们补上了，
// 于是「测试全绿、点保存必炸 providerAbove is not defined」。抽成一份再漏就是语法错误。

export const indentOf = (line) => (/^\s*/u.exec(line) || [''])[0].length;

export const isBlank = (line) => line.trim() === '';

/** 往上找某个字段所属的块：第一个缩进更小的 `键:` 行。 */
export function providerAbove(lines, from, fieldIndent) {
  for (let i = from - 1; i >= 0; i -= 1) {
    if (isBlank(lines[i])) continue;
    if (indentOf(lines[i]) >= fieldIndent) continue;
    const key = /^([\w.-]+):\s*$/u.exec(lines[i].trim());
    return key ? { key: key[1], start: i, indent: indentOf(lines[i]) } : null;
  }
  return null;
}

/** 块的结束行（不含）：第一行非空且缩进 <= 块缩进的位置。 */
export function blockEnd(lines, from, indent) {
  for (let i = from; i < lines.length; i += 1) {
    if (!isBlank(lines[i]) && indentOf(lines[i]) <= indent) return i;
  }
  return lines.length;
}
