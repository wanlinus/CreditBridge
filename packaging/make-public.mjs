// 把开发仓库导出成开源发布版（pub）：删掉逆向文档与探针、删掉除根 README 外的所有文档、
// 剥掉所有代码注释。
//
// 为什么要脚本而不是手工：手工删一次，下次重新导出又会带进去。每次同步都必须走同一条
// 路径，否则「pub 里没有逆向痕迹、没有注释」就只是一次性的、无法复验的承诺。
//
// 注释剥离分两类，用不同的手段：
//   - JS/TS（.ts/.js/.mjs/.cjs，以及 .vue 的 <script> 段）：用 TypeScript 自己的 scanner，
//     按词法走，能正确区分「注释」与「字符串里的斜杠」。裸 scanner 不行（见 commentRanges）。
//   - 其余（.css/.html/.vue 的 template、.ps1/.py/.yaml/.yml/Dockerfile/.dockerignore/.gitignore）：
//     各自写一个最小的状态机，只认字符串和注释两类词法，识别注释区间后复用同一套
//     「按行删除」逻辑（见 stripByRanges）。
//
// 文档（*.md）除根 README 外全部删除：发布版只需要一份 README（由 pub-README.md 生成）。
// 子目录的 README/API/ARCHITECTURE 是开发文档，对使用者没有意义。
//
// 用法：node packaging/make-public.mjs <目标目录>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const target = process.argv[2];

if (!target) {
  console.error('用法：node packaging/make-public.mjs <目标目录>');
  process.exit(1);
}

// TypeScript 的 parser 用来找注释。注意**不能用仓库里的那份**：cb-gateway 依赖的是
// TypeScript 7（tsgo 原生实现），它的 `exports["."]` 只导出时代号，没有 `createSourceFile`。
// 所以这里用 CB_TS_PATH 指向一份 TS 5.x；没设就退回本地的（本地是 7 就报错，提示装 5）。
const tsPath = process.env.CB_TS_PATH || path.join(repoRoot, 'cb-gateway', 'node_modules', 'typescript');
const ts = require(tsPath);
if (typeof ts.createSourceFile !== 'function') {
  console.error(`这份 typescript（${ts.version ?? '未知版本'}）没有 createSourceFile，无法剥注释。`);
  console.error('装一份 TS 5.x 并设 CB_TS_PATH 指向它，例如：');
  console.error('  npm install --prefix %TEMP%\\ts-strip typescript@5.9.3');
  console.error('  set CB_TS_PATH=%TEMP%\\ts-strip\\node_modules\\typescript');
  process.exit(1);
}

/** pub 里不出现的东西：给 AI 助手看的仓库守则，以及只在开发侧有意义的文件。 */
const EXCLUDE_FILES = [
  'AGENTS.md',
  // 转调 packaging/build.ps1；packaging 整个不进 pub（见 EXCLUDE_DIRS）。
  'build-package.ps1',
];

/** 不进发布版的目录：开发期的设计记录、逆向探针、以及强依赖文档的「分发包」工具。 */
const EXCLUDE_DIRS = [
  'docs',
  'tools/qoder-probe',
  // 加固盾探针：逆向侧工具，判据写在 private/docs/recon/reverse-engineering/09-加固盾识别与绕过.md 里（而 docs 不进 pub），
  // 对开源读者也没有使用场景——他们不是在被加固的产物里找协议。
  'tools/anti-re-probe',
  // 抓包工具：整套流程依赖 private/docs/mitm-guide.md 的说明（而 docs 不进 pub），
  // 且它抓的是上游私有协议——对开源读者没有可用场景，留着只会让人误以为
  // 这是产品功能的一部分。
  'tools/mitm',
  // 分发包工具（build.ps1 / install.ps1）在打包时要读 DIST-README.md 和各子目录
  // README/ARCHITECTURE.md——那些文档发布版里都没有，留着这套脚本就是坏代码。
  // 开源仓库的读者是开发者，直接 `node src/index.ts` 跑，不需要 Windows 安装包。
  'packaging',
];

/** 走 TypeScript scanner 的 JS/TS 后缀。 */
const CODE_EXT = new Set(['.ts', '.js', '.mjs', '.cjs']);

const SCRIPT_KIND = {
  '.ts': ts.ScriptKind.TS,
  '.js': ts.ScriptKind.JS,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
};

/**
 * 用 parser 找出所有注释区间；其余字节原样保留（不转译、不重排格式）。
 *
 * **不要用裸的 `ts.createScanner`**：`/` 是除法还是正则，只有 parser 有足够上下文判断。
 * scanner 判错之后状态就乱了——认不出 `/** … *​/` 块注释，还会把字符串里的 `/*`
 * （例如注释里写的 `` `data/auth/*.json` ``）当成块注释开始，一路吞掉后面的代码。
 * 实测过一次：`accounts.ts` 的 `writeFileAtomic(...)` 整行被删，`tsc` 报 TS1128。
 * parser 走完全程后，注释可以直接从节点区间的 trivia 里取，不用自己判歧义。
 */
function commentRanges(text, kind) {
  const sf = ts.createSourceFile('x', text, ts.ScriptTarget.Latest, /* setParentNodes */ true, kind);
  const ranges = [];
  const add = (list) => {
    if (!list) return;
    for (const r of list) ranges.push([r.pos, r.end]);
  };
  // **必须递归到 token 级**（`node.getChildren()`），不能用 `ts.forEachChild`：
  // 后者只访问语法节点，而 `catch { /* 注释 */ }` 这种**空块内部**的注释不属于任何
  // 语法节点，会被整片漏掉（实测漏了 1000 多处）。token 节点的 leading trivia 里才拿得到。
  const visit = (node) => {
    add(ts.getLeadingCommentRanges(text, node.getFullStart()));
    add(ts.getTrailingCommentRanges(text, node.getEnd()));
    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);
  return ranges;
}

/** CSS 注释 `/* … *​/`（字符串感知）。区间是 [start, end)。 */
function cssRanges(text) {
  const ranges = [];
  const n = text.length;
  let i = 0;
  let mode = 'normal';
  let quote = '';
  while (i < n) {
    const c = text[i];
    if (mode === 'string') {
      if (c === '\\') i += 2;
      else if (c === quote) { mode = 'normal'; i += 1; }
      else i += 1;
    } else if (c === '/' && text[i + 1] === '*') {
      const start = i;
      const end = text.indexOf('*/', i + 2);
      if (end === -1) { ranges.push([start, n]); break; }
      ranges.push([start, end + 2]);
      i = end + 2;
    } else if (c === '"' || c === "'") {
      mode = 'string';
      quote = c;
      i += 1;
    } else i += 1;
  }
  return ranges;
}

/** HTML 注释 `<!-- … -->`。 */
function htmlRanges(text) {
  const ranges = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const idx = text.indexOf('<!--', i);
    if (idx === -1) break;
    const end = text.indexOf('-->', idx + 4);
    if (end === -1) { ranges.push([idx, n]); break; }
    ranges.push([idx, end + 3]);
    i = end + 3;
  }
  return ranges;
}

/**
 * Vue SFC：`<script>` / `<template>` / `<style>` 三段，各用对应语言的剥离器。
 * template 段可能嵌套 `<template>`（`<template #note>` 等），必须计数配对，不能用
 * indexOf 找第一个 `</template>`——那样会漏掉嵌套标签之后的注释。
 */
function vueRanges(text) {
  const ranges = [];

  for (const [open, close, kind] of [
    ['<script', '</script>', 'js'],
    ['<style', '</style>', 'css'],
  ]) {
    const openIdx = text.indexOf(open);
    if (openIdx === -1) continue;
    const tagEnd = text.indexOf('>', openIdx);
    const closeIdx = text.indexOf(close, tagEnd + 1);
    if (tagEnd === -1 || closeIdx === -1) continue;
    const seg = text.slice(tagEnd + 1, closeIdx);
    const segRanges = kind === 'js' ? commentRanges(seg, ts.ScriptKind.TS) : cssRanges(seg);
    for (const [s, e] of segRanges) ranges.push([tagEnd + 1 + s, tagEnd + 1 + e]);
  }

  const tOpen = text.indexOf('<template');
  if (tOpen !== -1) {
    const tagEnd = text.indexOf('>', tOpen);
    let depth = 1;
    let i = tagEnd + 1;
    let contentEnd = -1;
    while (i < text.length) {
      const open = text.indexOf('<template', i);
      const close = text.indexOf('</template>', i);
      if (close === -1) break;
      if (open !== -1 && open < close) {
        depth += 1;
        i = open + '<template'.length;
      } else {
        depth -= 1;
        i = close + '</template>'.length;
        if (depth === 0) { contentEnd = close; break; }
      }
    }
    if (contentEnd !== -1) {
      const seg = text.slice(tagEnd + 1, contentEnd);
      for (const [s, e] of htmlRanges(seg)) ranges.push([tagEnd + 1 + s, tagEnd + 1 + e]);
    }
  }

  ranges.sort((a, b) => a[0] - b[0]);
  return ranges;
}

/**
 * PowerShell：`#` 行注释 + `<# … #>` 块注释（可嵌套），字符串感知。
 * `#Requires` 是指令不是注释，必须保留——它一旦被删，脚本在 PS 5.1 下会按
 * 缺省版本语义跑，静默改变行为。
 */
function ps1Ranges(text) {
  const ranges = [];
  const n = text.length;
  let i = 0;
  let mode = 'normal';
  let depth = 0;
  let blockStart = -1;
  while (i < n) {
    const c = text[i];
    if (mode === 'squote') {
      if (c === "'") {
        if (text[i + 1] === "'") i += 2;
        else { mode = 'normal'; i += 1; }
      } else i += 1;
    } else if (mode === 'dquote') {
      if (c === '`') i += 2;
      else if (c === '"') { mode = 'normal'; i += 1; }
      else i += 1;
    } else if (mode === 'block') {
      if (c === '<' && text[i + 1] === '#') { depth += 1; i += 2; }
      else if (c === '#' && text[i + 1] === '>') {
        depth -= 1;
        i += 2;
        if (depth === 0) { mode = 'normal'; ranges.push([blockStart, i]); }
      } else i += 1;
    } else if (c === "'") { mode = 'squote'; i += 1; }
    else if (c === '"') { mode = 'dquote'; i += 1; }
    else if (c === '<' && text[i + 1] === '#') { blockStart = i; depth = 1; mode = 'block'; i += 2; }
    else if (c === '#') {
      const lineStart = text.lastIndexOf('\n', i - 1) + 1;
      const prefix = text.slice(lineStart, i);
      if (/^[ \t]*$/.test(prefix) && /^#[Rr]equires\b/.test(text.slice(i))) {
        const nl = text.indexOf('\n', i);
        i = nl === -1 ? n : nl + 1;
      } else {
        const start = i;
        const nl = text.indexOf('\n', i);
        const end = nl === -1 ? n : nl;
        ranges.push([start, end]);
        i = end;
      }
    } else i += 1;
  }
  return ranges;
}

/** Python：`#` 行注释（字符串感知）+ 文件开头的模块 docstring。 */
function pyRanges(text) {
  const ranges = [];
  const n = text.length;

  // 模块 docstring：文件开头（跳过 shebang 与空白）的第一个三引号字符串。
  // 它本质是字符串字面量，但语义是「文档」，按「无注释」的要求剥掉。
  let head = 0;
  if (text.startsWith('#!')) {
    const nl = text.indexOf('\n');
    head = nl === -1 ? n : nl + 1;
  }
  let j = head;
  while (j < n && /[ \t\r\n]/.test(text[j])) j += 1;
  if (text.startsWith('"""', j) || text.startsWith("'''", j)) {
    const q = text.slice(j, j + 3);
    const end = text.indexOf(q, j + 3);
    if (end !== -1) ranges.push([j, end + 3]);
  }

  let i = 0;
  let mode = 'normal';
  while (i < n) {
    const c = text[i];
    if (mode === 'sq') {
      if (c === '\\') i += 2;
      else if (c === "'") { mode = 'normal'; i += 1; }
      else i += 1;
    } else if (mode === 'dq') {
      if (c === '\\') i += 2;
      else if (c === '"') { mode = 'normal'; i += 1; }
      else i += 1;
    } else if (mode === 'tsq') {
      if (text.startsWith("'''", i)) { mode = 'normal'; i += 3; }
      else i += 1;
    } else if (mode === 'tdq') {
      if (text.startsWith('"""', i)) { mode = 'normal'; i += 3; }
      else i += 1;
    } else if (c === '#') {
      const start = i;
      const nl = text.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      ranges.push([start, end]);
      i = end;
    } else if (text.startsWith("'''", i)) { mode = 'tsq'; i += 3; }
    else if (text.startsWith('"""', i)) { mode = 'tdq'; i += 3; }
    else if (c === "'") { mode = 'sq'; i += 1; }
    else if (c === '"') { mode = 'dq'; i += 1; }
    else i += 1;
  }
  return ranges;
}

/**
 * YAML：`#` 只在「行首或前面是空白」时才是注释（裸标量里的 `#`，如 `http://x#y`，是值）。
 * 引号字符串感知。
 */
function yamlRanges(text) {
  const ranges = [];
  const n = text.length;
  let i = 0;
  let lineStart = true;
  let mode = 'normal';
  while (i < n) {
    const c = text[i];
    if (mode === 'squote') {
      if (c === "'") {
        if (text[i + 1] === "'") i += 2;
        else { mode = 'normal'; i += 1; }
      } else i += 1;
    } else if (mode === 'dquote') {
      if (c === '\\') i += 2;
      else if (c === '"') { mode = 'normal'; i += 1; }
      else i += 1;
    } else if (c === '\n') { lineStart = true; i += 1; }
    else if (c === ' ' || c === '\t') { i += 1; }
    else if (c === '#') {
      if (lineStart || text[i - 1] === ' ' || text[i - 1] === '\t') {
        const start = i;
        const nl = text.indexOf('\n', i);
        const end = nl === -1 ? n : nl;
        ranges.push([start, end]);
        i = end;
      } else i += 1;
    } else if (c === "'") { mode = 'squote'; lineStart = false; i += 1; }
    else if (c === '"') { mode = 'dquote'; lineStart = false; i += 1; }
    else { lineStart = false; i += 1; }
  }
  return ranges;
}

/** Dockerfile / .dockerignore / .gitignore：只有行首 `#`（前导空白后）才是注释。 */
function hashLineRanges(text) {
  const ranges = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const m = /^[ \t]*#/.exec(line);
    if (m) ranges.push([offset + m[0].length - 1, offset + line.length]);
    offset += line.length + 1;
  }
  return ranges;
}

/** 按扩展名/文件名分发到对应剥离器；返回注释区间数组，不处理的类型返回 null。 */
function rangesFor(name, text) {
  const ext = path.extname(name);
  const base = path.basename(name);
  if (CODE_EXT.has(ext)) return commentRanges(text, SCRIPT_KIND[ext]);
  if (ext === '.vue') return vueRanges(text);
  if (ext === '.css') return cssRanges(text);
  if (ext === '.html') return htmlRanges(text);
  if (ext === '.ps1') return ps1Ranges(text);
  if (ext === '.py') return pyRanges(text);
  if (ext === '.yaml' || ext === '.yml') return yamlRanges(text);
  if (base === 'Dockerfile' || base === '.dockerignore' || base === '.gitignore') return hashLineRanges(text);
  return null;
}

/**
 * 读文件、规范化换行、算区间、剥注释的完整流程。所有文件类型都走这里。
 *
 * 换行规范化必须在算区间**之前**：`git archive` 在 Windows 上导出的是 CRLF，区间和
 * 删除必须基于同一份文本，否则偏移错位会把正常代码当注释切掉。
 */
function stripFile(full) {
  const raw = fs.readFileSync(full, 'utf8');
  const text = raw.includes('\r\n') ? raw.replace(/\r\n/gu, '\n') : raw;
  const ranges = rangesFor(path.basename(full), text);
  if (!ranges || ranges.length === 0) return { text, removed: 0 };
  return stripByRanges(text, ranges);
}

/**
 * 删掉注释区间。
 *
 * **逐行处理，而不是「整段删完再压空行」**：注释独占一行时，整段删除会留下一行空行——
 * 源码里连着几行注释，剥完就多出几行空白，函数看着像被掏空。这里的规则是：
 * 一行**原来不是空的**、剥掉注释后变成空的，就把整行删掉；原来就是空行的才保留。
 * 行尾注释只切掉注释本身，代码不动。
 */
function stripByRanges(text, ranges) {
  if (ranges.length === 0) return { text, removed: 0 };

  // `text` 是已经规范化成 LF 的文本，`ranges` 也是基于同一份文本算出的偏移。
  // **规范化必须发生在 `ranges` 计算之前（由调用方负责）**：`git archive` 在 Windows 上
  // 导出的文件是 CRLF，如果 ranges 按 CRLF 文本算、这里却换成 LF 再删，偏移全部错位，
  // 会把正常代码当注释切掉（2026-11-13 实测整份 client.js 被切得支离破碎）。

  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }

  const out = [];
  let offset = 0;
  let next = 0;

  for (const line of text.split('\n')) {
    const lineStart = offset;
    const lineEnd = offset + line.length;
    offset = lineEnd + 1;

    while (next < merged.length && merged[next][1] <= lineStart) next += 1;

    let kept = '';
    let cursor = lineStart;
    let touched = false;
    for (let i = next; i < merged.length && merged[i][0] < lineEnd; i += 1) {
      const from = Math.max(merged[i][0], lineStart);
      const to = Math.min(merged[i][1], lineEnd);
      if (to <= from) continue;
      kept += text.slice(cursor, from);
      cursor = to;
      touched = true;
    }
    const rest = touched ? kept + text.slice(cursor, lineEnd) : line;

    if (rest.trim() === '' && line.trim() !== '') continue;
    out.push(rest.replace(/[ \t]+$/u, ''));
  }

  const result = out.join('\n').replace(/\n{3,}/gu, '\n\n').replace(/^\n+/u, '');
  return { text: result, removed: merged.length };
}

// ---------------------------------------------------------------- 1. 导出

// **先拦未提交的改动**：`git archive` 打的是 HEAD，工作区里改了但没提交的内容不会进发布版，
// 而导出照常成功——这正是「发布版和开发版不一致」的静默失败形态（2026-11-12 踩过一次：
// 文档刚改完就跑了脚本，pub 里还是旧文本，直到 grep 才发现）。
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim();
if (dirty !== '') {
  console.error('工作区有未提交改动，导出会拿到旧内容（git archive 打的是 HEAD）。先提交再跑：');
  console.error(dirty.split('\n').slice(0, 10).join('\n'));
  process.exit(1);
}

// 不删目标目录本身，只清空它的内容：目录被 IDE（`.idea/`）或杀软占着时，rmSync 会 EPERM，
// 而「删不掉就整个失败」会让一次生成白跑。清空内容同样能达到「不留上一次的旧文件」。
fs.mkdirSync(target, { recursive: true });
const stuck = [];
for (const entry of fs.readdirSync(target)) {
  try {
    fs.rmSync(path.join(target, entry), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    stuck.push(entry);
  }
}
if (stuck.length > 0) {
  // 删不掉的通常是编辑器/杀软正握着句柄。只要它在 .gitignore 里，就不会进版本库，
  // 也就不会进发布版——所以这里只警告，不中断。
  console.warn(`警告：这些条目没删掉（可能被占用），确认它们已被 .gitignore 排除 —— ${stuck.join('，')}`);
}
const tar = path.join(process.env.TEMP || '/tmp', 'cb-public.tar');
execFileSync('git', ['archive', '--format=tar', 'HEAD', '-o', tar], { cwd: repoRoot });
execFileSync('tar', ['-xf', tar, '-C', target]);

// ---------------------------------------------------------------- 2. 删除排除项

let removedEntries = 0;
for (const rel of EXCLUDE_FILES) {
  const p = path.join(target, rel);
  if (!fs.existsSync(p)) continue;
  fs.rmSync(p);
  removedEntries += 1;
  console.log(`删除文件  ${rel}`);
}
for (const rel of EXCLUDE_DIRS) {
  const p = path.join(target, rel);
  if (!fs.existsSync(p)) continue;
  let n = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else n += 1;
    }
  };
  walk(p);
  fs.rmSync(p, { recursive: true, force: true });
  removedEntries += n;
  console.log(`删除目录  ${rel}/  ${n} 个文件`);
}

// 删除除根 README 外的所有文档（*.md）。根 README 随后由 pub-README.md 重建。
const walkRemoveMd = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      walkRemoveMd(full);
    } else if (entry.name.toLowerCase().endsWith('.md')) {
      fs.rmSync(full);
      removedEntries += 1;
      console.log(`删除文档  ${path.relative(target, full)}`);
    }
  }
};
walkRemoveMd(target);

// ---------------------------------------------------------------- 3. 剥注释

let codeFiles = 0;
let commentsRemoved = 0;
const walkStrip = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      walkStrip(full);
      continue;
    }
    const { text: stripped, removed } = stripFile(full);
    if (removed === 0) continue;
    fs.writeFileSync(full, stripped, 'utf8');
    codeFiles += 1;
    commentsRemoved += removed;
  }
};
walkStrip(target);

// README 换成发布版模板（pub-README.md，它自己也随 packaging/ 被排除）。
fs.copyFileSync(path.join(repoRoot, 'packaging', 'pub-README.md'), path.join(target, 'README.md'));

// ---------------------------------------------------------------- 4. 自检

// 自检：剥离后重新解析一遍，剩余注释必须是 0。没有这一步，就只能靠抽查猜有没有漏。
let leftover = 0;
const leftoverFiles = [];
const walkCheck = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      walkCheck(full);
      continue;
    }
    const raw = fs.readFileSync(full, 'utf8');
    const text = raw.includes('\r\n') ? raw.replace(/\r\n/gu, '\n') : raw;
    const ranges = rangesFor(entry.name, text);
    if (!ranges || ranges.length === 0) continue;
    leftover += ranges.length;
    leftoverFiles.push(`${path.relative(target, full)} ×${ranges.length}`);
  }
};
walkCheck(target);

console.log(`\n删除 ${removedEntries} 个文件/条目`);
console.log(`剥掉注释：${codeFiles} 个代码文件，共 ${commentsRemoved} 处`);
console.log(leftover === 0 ? '自检：剩余注释 0 处 ✓' : `自检：仍有 ${leftover} 处注释 —— ${leftoverFiles.slice(0, 5).join('，')}`);
console.log(`输出目录：${target}`);
