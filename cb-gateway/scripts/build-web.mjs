import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY_DIR = path.resolve(HERE, '..');
const WEB_DIR = path.join(GATEWAY_DIR, 'web');

const args = process.argv.slice(2);
const checkOnly = args.includes('--check-only');
const noInstall = args.includes('--no-install');

function findPnpm() {
  const isWin = process.platform === 'win32';
  const onPath = spawnSync(isWin ? 'where' : 'which', [isWin ? 'pnpm.cmd' : 'pnpm'], { encoding: 'utf8' });
  if (onPath.status === 0 && onPath.stdout.trim()) {
    const first = onPath.stdout.trim().split(/\r?\n/)[0].trim();
    const needsShell = /\.(cmd|bat)$/i.test(first);
    return { cmd: first, preArgs: [], shell: needsShell, label: `PATH 上的 pnpm（${first}）` };
  }

  const runtimes = path.join(os.homedir(), '.dsh', 'dsh-runtimes');
  if (fs.existsSync(runtimes)) {
    for (const name of fs.readdirSync(runtimes)) {
      const candidate = path.join(runtimes, name, 'dependencies', 'pnpm', 'bin', 'pnpm.cjs');
      if (fs.existsSync(candidate)) {
        return {
          cmd: process.execPath,
          preArgs: [candidate],
          shell: false,
          label: `DSH 运行时里的 pnpm（${name}）`,
        };
      }
    }
  }
  return null;
}

const pnpm = findPnpm();
if (!pnpm) {
  console.error(
    [
      '找不到 pnpm。三种解法（任选一个）：',
      '  1. 装一个全局 pnpm：npm i -g pnpm',
      '  2. 用 DSH 运行时里的那个：node ~/.dsh/dsh-runtimes/*/dependencies/pnpm/bin/pnpm.cjs',
      '  3. 直接用 npm（会生成 package-lock.json 而不是 pnpm-lock.yaml，仓库里锁的是后者，不建议）',
    ].join('\n'),
  );
  process.exit(1);
}
console.log(`pnpm: ${pnpm.label}`);

function runPnpm(pnpmArgs, label) {
  console.log(`\n> ${label}`);

  const argv = [...pnpm.preArgs, ...pnpmArgs];
  const command = pnpm.shell ? [pnpm.cmd, ...argv].map((s) => (/\s/.test(s) ? `"${s}"` : s)).join(' ') : pnpm.cmd;
  const spawnArgs = pnpm.shell ? [] : argv;

  const r = spawnSync(command, spawnArgs, {
    cwd: WEB_DIR,
    stdio: 'inherit',
    env: process.env,
    shell: pnpm.shell,
  });
  if (r.error) {
    console.error(`\n✗ ${label} 起不来：${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`\n✗ ${label} 失败（exit ${r.status}）`);
    process.exit(r.status ?? 1);
  }
}

if (checkOnly) {
  if (!fs.existsSync(path.join(WEB_DIR, 'node_modules'))) {
    runPnpm(['install', '--frozen-lockfile'], '安装依赖（首次）');
  }
  runPnpm(['run', 'check'], '类型检查 vue-tsc');
  console.log('\n✓ 类型检查通过');
  process.exit(0);
}

const needInstall = !noInstall && !fs.existsSync(path.join(WEB_DIR, 'node_modules'));
if (needInstall) {
  runPnpm(['install', '--frozen-lockfile'], '安装依赖（首次，可能几分钟）');
}

runPnpm(['run', 'build'], '构建前端（vue-tsc + vite build）');

const dist = path.join(WEB_DIR, 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('\n✗ 构建结束但 dist/index.html 不存在——检查 web/vite.config.ts 的 outDir。');
  process.exit(1);
}
const files = fs.readdirSync(path.join(dist, 'assets'));
console.log(`\n✓ 产物就绪：web/dist/index.html + assets/（${files.length} 个文件）`);
console.log('  网关的 /v3 会直接读它，不需要重启。');
