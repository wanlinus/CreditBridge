// 构建 `web/` 前端产物。给 `npm run build:web` 用。
//
// ## 为什么要这层包装
//
// 本机**没有全局 pnpm**（`Get-Command pnpm` 找不到），只有 DSH 运行时里那一份
// （`~/.dsh/dsh-runtimes/*/dependencies/pnpm/bin/pnpm.cjs`）。`web/` 用 pnpm 是因为
// 它和 jxc 同一套工具链。
//
// 直接写 `pnpm --dir web build` 在这台机器上跑不了；写死 DSH 路径又会让别人的机器跑不了。
// 所以按「PATH → DSH 运行时 → 报错并说清楚怎么办」的顺序找。
//
// ## 用法
//
//   node scripts/build-web.mjs               安装（缺时）+ 构建
//   node scripts/build-web.mjs --check-only  只跑 vue-tsc，不出产物
//   node scripts/build-web.mjs --no-install  跳过安装，直接构建
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

/** 找 pnpm：PATH 上的优先，其次 DSH 运行时里那份。返回 `{cmd, preArgs, shell}`。 */
function findPnpm() {
  // Windows 上 `where pnpm` 可能返回 `pnpm.ps1` / `pnpm.cmd` 两个。`.ps1` 不能直接
  // spawn（会 `status: null`），必须让 cmd.exe 去跑 `.cmd` 版本——所以这里优先找
  // `pnpm.cmd`，并配 `shell: true`。
  const isWin = process.platform === 'win32';
  const onPath = spawnSync(isWin ? 'where' : 'which', [isWin ? 'pnpm.cmd' : 'pnpm'], { encoding: 'utf8' });
  if (onPath.status === 0 && onPath.stdout.trim()) {
    const first = onPath.stdout.trim().split(/\r?\n/)[0].trim();
    // `.cmd` / `.bat` **不能**直接 spawn：Node 22+ 为了防命令注入，对这类文件返回
    // EINVAL，必须交给 shell 执行（2026-11-12 实测：`spawnSync pnpm.cmd EINVAL`）。
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

/** 跑一条 pnpm 命令，实时透传输出（构建日志要能看见）。 */
function runPnpm(pnpmArgs, label) {
  console.log(`\n> ${label}`);

  // shell 模式下要把命令拼成**一个字符串**再传，而不是「命令 + 参数数组」：
  // 后者会触发 Node 的 DEP0190（参数不转义直接拼进命令行，是注入面）。
  // 这里的参数全是本文件里的字面量，没有用户输入，但仍按推荐写法来。
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
  // `vue-tsc --noEmit` 不需要 node_modules 之外的东西，缺了也装不上就在下面报错。
  if (!fs.existsSync(path.join(WEB_DIR, 'node_modules'))) {
    runPnpm(['install', '--frozen-lockfile'], '安装依赖（首次）');
  }
  runPnpm(['run', 'check'], '类型检查 vue-tsc');
  console.log('\n✓ 类型检查通过');
  process.exit(0);
}

const needInstall = !noInstall && !fs.existsSync(path.join(WEB_DIR, 'node_modules'));
if (needInstall) {
  // `--frozen-lockfile`：用锁文件里钉住的版本，不要「顺手」升级。
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
