/**
 * 找死导出：导出了给别人用，但**没有任何文件引用过**。
 *
 * ## 和 `find-dead-code.mjs` 的分工
 *
 * - `find-dead-code.mjs`：**单文件内**，找「定义了但本文件和本模板都没用」
 * - 本脚本：**跨文件**，找「导出了但没人 import」——导出天生是给别处用的，
 *   单文件视角对它无能为力
 *
 * ## 怎么判
 *
 * 取所有 `export function foo` / `export const foo`，然后在**全部源文件 + 全部测试**
 * 里数 `foo` 出现的次数。**只出现 1 次（就是定义那一处）= 没人用。**
 *
 * 为什么不做「排除定义行」：`export const X = ...` 的定义行本身可能还引用自己一次
 * （`export const A = 1, B = A`），按位置排除容易误判。用「总次数 ≤ 1」这个判据
 * 更保守——只会漏报，不会误报。
 *
 * 测试（`.mjs`）也算引用：测试专用的导出（`resetXxxForTests`）是合法的。
 *
 * 用法：`node tools/find-dead-exports.mjs`
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const TEST = path.join(HERE, '..', 'test');

function walk(dir, filter) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, filter));
    else if (filter(entry.name)) out.push(full);
  }
  return out;
}

const srcFiles = walk(SRC, (n) => n.endsWith('.ts'));
const testFiles = walk(TEST, (n) => n.endsWith('.mjs'));

const sourceOf = new Map();
for (const file of [...srcFiles, ...testFiles]) sourceOf.set(file, fs.readFileSync(file, 'utf8'));
const combined = [...sourceOf.values()].join('\n');

const exported = [];
for (const file of srcFiles) {
  sourceOf.get(file).split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (line.startsWith('*') || line.startsWith('//')) return;
    const fn = /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/u.exec(line);
    if (fn) {
      exported.push({ ident: fn[1], file, line: index + 1, kind: 'function' });
      return;
    }
    const cst = /^export\s+(?:const|let)\s+([A-Za-z_$][\w$]*)/u.exec(line);
    if (cst) exported.push({ ident: cst[1], file, line: index + 1, kind: 'const' });
  });
}

const dead = [];
for (const item of exported) {
  const re = new RegExp(`(?<![\\w$])${item.ident.replace(/\$/gu, '\\$')}(?![\\w$])`, 'gu');
  const total = (combined.match(re) || []).length;
  if (total <= 1) dead.push({ ...item, total, inTest: countInTests(item.ident) });
}

/** 只在测试里出现、源文件里没有 = 「只有测试在用」，值得单独标出来。 */
function countInTests(ident) {
  const re = new RegExp(`(?<![\\w$])${ident.replace(/\$/gu, '\\$')}(?![\\w$])`, 'gu');
  let n = 0;
  for (const file of testFiles) n += (sourceOf.get(file).match(re) || []).length;
  return n;
}

console.log(
  `扫描 ${srcFiles.length} 个源文件 + ${testFiles.length} 个测试，共 ${exported.length} 个导出。`,
);
if (dead.length === 0) {
  console.log('没有死导出：每个导出都至少被引用一次。');
} else {
  console.log(`\n只出现一次（定义处）的导出（${dead.length}）：\n`);
  for (const item of dead) {
    const tag = item.inTest > 0 ? '（只有测试在用）' : '（谁都没用）';
    console.log(`  ${path.relative(SRC, item.file)}:${item.line}  [${item.kind}] ${item.ident} ${tag}`);
  }
}
