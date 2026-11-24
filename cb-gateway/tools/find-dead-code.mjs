/**
 * 死代码扫描：找「定义了但没被任何地方引用」的顶层声明。
 *
 * ## 为什么自己写而不用现成工具
 *
 * 试过两个，都不适用：
 *
 *   - **knip 6**：只会报「导出的类型没被 import」，而且误报——它报 `UsageResponse`
 *     未使用，但 `api/usage.ts` 的返回类型就在用它；`<script setup>` 里模板引用的
 *     算不算用，它判不全。
 *   - **eslint + @typescript-eslint**：`.ts` 里零命中（确实没有死变量），但 `.vue`
 *     要额外装 vue-eslint-parser，而 `@typescript-eslint/no-unused-vars` **会忽略
 *     导出的声明**——这个仓库的 API 函数全是导出的，等于漏掉整类目标。
 *
 * ## 它怎么判
 *
 * 按语言结构取顶层 `function foo` / `const foo =`，然后分两处数引用：
 *   1. 同文件 `<script>` 里、定义行之外
 *   2. 同文件 `<template>` 里（模板引用也算用）
 * 两处都是 0 才算死代码。
 *
 * **已知误报**：跨文件导入进来的名字（比如 `const { flash, say } = useFlash()`
 * 里的 `say`）在别处用着，但本文件的模板里没有再出现——这类会出现在结果里，
 * 需要人看一眼。脚本最后会提示「import 进来的名字除外」。
 *
 * 用法：`node tools/find-dead-code.mjs`
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.join(HERE, '..', 'src');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|vue)$/u.test(entry.name)) out.push(full);
  }
  return out;
}

/** 从源码里抽出「逻辑部分」和「模板部分」。 */
function splitVue(text) {
  if (!text.includes('<template>')) return { logic: text, template: '' };
  const script = /<script[^>]*>([\s\S]*?)<\/script>/u.exec(text);
  const template = /<template>([\s\S]*)<\/template>/u.exec(text);
  return { logic: script ? script[1] : '', template: template ? template[1] : '' };
}

/** 收集顶层声明，带上它是不是从别处 import 进来的（后者不算。 */
function collectDeclarations(logic) {
  const decls = [];
  const imported = new Set();

  for (const raw of logic.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('*') || line.startsWith('//') || line.startsWith('/*')) continue;

    // import { a, b as c } from '...' —— 这些名字是「从别处拿来的」，不是本地死代码
    const imp = /^import\s+(?:type\s+)?\{([^}]*)\}/u.exec(line);
    if (imp) {
      for (const part of imp[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/u).pop()?.trim();
        if (name && /^[A-Za-z_$][\w$]*$/u.test(name)) imported.add(name);
      }
      continue;
    }
    // import Foo from '...'
    const impDefault = /^import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s+from/u.exec(line);
    if (impDefault) {
      imported.add(impDefault[1]);
      continue;
    }
  }

  logic.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (line.startsWith('*') || line.startsWith('//') || line.startsWith('/*')) return;

    const exported = /^export\s/u.test(line);
    const fn = /(?:^|\s)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/u.exec(raw);
    if (fn) {
      decls.push({ ident: fn[1], kind: 'function', line: index + 1, exported });
      return;
    }
    const cst = /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/u.exec(raw);
    if (cst) decls.push({ ident: cst[1], kind: 'const', line: index + 1, exported });
  });

  return { decls, imported };
}

function main() {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_ROOT;
  const files = walk(root);
  const dead = [];

  // 先把所有文件读进来：**导出的东西可能被别的文件 import**，
  // 只在单文件里数会把每一个导出都报成死代码（整个仓库的公共 API 都被误报）。
  const sources = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));
  const combined = [...sources.values()].join('\n');

  for (const file of files) {
    const { logic, template } = splitVue(sources.get(file));
    const { decls, imported } = collectDeclarations(logic);

    for (const decl of decls) {
      if (imported.has(decl.ident)) continue;
      const re = new RegExp(`(?<![\\w$])${decl.ident.replace(/\$/gu, '\\$')}(?![\\w$])`, 'gu');

      // 导出的一律跳过：它天生是给别的文件用的，判断它的是 `find-dead-exports.mjs`。
      if (decl.exported) continue;

      // **跨文件也算引用**——本文件里没用到，但别的文件 import 了它，那不算死。
      const anywhere = (combined.match(re) || []).length;
      if (anywhere > 1) continue;

      dead.push({ file: path.relative(root, file), ...decl });
    }
  }

  if (dead.length === 0) {
    console.log(`扫描 ${files.length} 个文件：没有发现定义了却没被引用的顶层声明。`);
    return;
  }

  console.log(`扫描 ${files.length} 个文件，发现 ${dead.length} 个可疑声明：\n`);
  for (const item of dead) {
    console.log(`  ${item.file}:${item.line}  [${item.kind}] ${item.ident}`);
  }
  console.log('\n注意：跨文件导入的名字可能被误报（本文件模板里没再出现），需要人工确认。');
}

main();
