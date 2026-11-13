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

function splitVue(text) {
  if (!text.includes('<template>')) return { logic: text, template: '' };
  const script = /<script[^>]*>([\s\S]*?)<\/script>/u.exec(text);
  const template = /<template>([\s\S]*)<\/template>/u.exec(text);
  return { logic: script ? script[1] : '', template: template ? template[1] : '' };
}

function collectDeclarations(logic) {
  const decls = [];
  const imported = new Set();

  for (const raw of logic.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('*') || line.startsWith('//') || line.startsWith('/*')) continue;

    const imp = /^import\s+(?:type\s+)?\{([^}]*)\}/u.exec(line);
    if (imp) {
      for (const part of imp[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/u).pop()?.trim();
        if (name && /^[A-Za-z_$][\w$]*$/u.test(name)) imported.add(name);
      }
      continue;
    }
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

  const sources = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));
  const combined = [...sources.values()].join('\n');

  for (const file of files) {
    const { logic, template } = splitVue(sources.get(file));
    const { decls, imported } = collectDeclarations(logic);

    for (const decl of decls) {
      if (imported.has(decl.ident)) continue;
      const re = new RegExp(`(?<![\\w$])${decl.ident.replace(/\$/gu, '\\$')}(?![\\w$])`, 'gu');

      if (decl.exported) continue;

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
