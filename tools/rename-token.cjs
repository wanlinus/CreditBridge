// 把仓库里某个标识符统一改名（只动 git 跟踪的文件）。
//
// 为什么做成带参数的通用脚本：这次改 `dsh-quota-bridge` -> `qb-dsh`，上一次是
// `quota-bridge-gateway` -> `qb-gateway`，下次还会再有。写死一个词就得再写一遍。
//
// 为什么不用 PowerShell 的 -replace 管道：仓库里全是中文，PS 5.1 按 GBK 读写会
// 静默把中文变成乱码（本仓库真踩过）。
//
// 用法：
//   node tools/rename-token.cjs <旧词> <新词>            # 预览
//   node tools/rename-token.cjs <旧词> <新词> --write    # 落盘
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const args = process.argv.slice(2).filter((a) => a !== '--write');
const write = process.argv.includes('--write');
const [OLD, NEW] = args;

if (!OLD || !NEW) {
  console.error('用法: node tools/rename-token.cjs <旧词> <新词> [--write]');
  process.exit(1);
}

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);

let changedFiles = 0;
let changedHits = 0;
const report = [];

for (const file of files) {
  let text;
  try {
    const buf = fs.readFileSync(file);
    // 含 NUL 的当二进制跳过（图片等），否则会写坏它们
    if (buf.includes(0)) continue;
    text = buf.toString('utf8');
  } catch {
    continue;
  }
  const count = text.split(OLD).length - 1;
  if (count === 0) continue;

  changedFiles += 1;
  changedHits += count;
  report.push({ file, count });

  if (write) fs.writeFileSync(file, text.split(OLD).join(NEW), 'utf8');
}

report.sort((a, b) => b.count - a.count);
for (const r of report) console.log(`  ${String(r.count).padStart(2)}x  ${r.file}`);
console.log(`\n${write ? '已修改' : '待修改'} ${changedFiles} 个文件，共 ${changedHits} 处`);
if (!write) console.log('这是预览。加 --write 才会落盘。');
