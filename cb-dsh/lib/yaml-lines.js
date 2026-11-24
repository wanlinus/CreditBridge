// 编辑 profile YAML 的**行级**工具。
//
// profile（`cordis.patch.yml`）是手写的：有注释、有引号、键顺序是刻意的。所以这个插件
// 一律**按行改**，不做 YAML 序列化往返——往返会把注释、引号风格、键顺序全部重排，
// 一份人写的配置往返几次就没法看了。
//
// 两个文件都要这套动作：
//   - `index.js` 的 `writeProvider()`：改 `baseURL` / 凭据字段
//   - `profile-models.js`：改 `models:` 段
//
// 早先两边各写一份，结果 `index.js` 那份**漏了 `providerAbove` / `blockEnd`**，
// 而测试自带桩把这俩补上了，于是「测试全绿、点保存必炸 `providerAbove is not
// defined`」。抽到这里只留一份，再漏就是语法错误，编译期就能看见。

export const indentOf = (line) => (/^\s*/u.exec(line) || [''])[0].length;

export const isBlank = (line) => line.trim() === '';

/**
 * 往上找某个字段所属的块。
 *
 * `from` 是字段所在行，`fieldIndent` 是字段的缩进；返回第一个缩进更小的
 * `键:` 行作为该块的开头（`{ key, start, indent }`），找不到返回 `null`。
 */
export function providerAbove(lines, from, fieldIndent) {
  for (let i = from - 1; i >= 0; i -= 1) {
    if (isBlank(lines[i])) continue;
    if (indentOf(lines[i]) >= fieldIndent) continue;
    const key = /^([\w.-]+):\s*$/u.exec(lines[i].trim());
    return key ? { key: key[1], start: i, indent: indentOf(lines[i]) } : null;
  }
  return null;
}

/** 块的结束行（不含）：第一行非空且缩进 <= 块缩进的位置；到底了返回 `lines.length`。 */
export function blockEnd(lines, from, indent) {
  for (let i = from; i < lines.length; i += 1) {
    if (!isBlank(lines[i]) && indentOf(lines[i]) <= indent) return i;
  }
  return lines.length;
}
