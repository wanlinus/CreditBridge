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
