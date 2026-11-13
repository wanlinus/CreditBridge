import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROFILE = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
const PLUGIN_DIR = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'cb-dsh', 'lib');
const CHANNELS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'channels');

function channelIds() {
  try {
    return fs
      .readdirSync(CHANNELS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(CHANNELS_DIR, entry.name, 'index.ts')))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

const CHANNEL_IDS = channelIds();

const V1_SUFFIX_RE = new RegExp(`/(${CHANNEL_IDS.join('|')})/v1$`, 'u');
function isGatewayBaseUrl(value) {
  try {
    if (new URL(value).pathname === '/v1') return true;
  } catch {
  }
  return CHANNEL_IDS.length === 0 || V1_SUFFIX_RE.test(value);
}

const REQUIRED_ENTRIES = ['llm-deepseek', 'permission', 'llm-pi-ai', 'agent-default-model'];

const problems = [];
const notes = [];

if (!fs.existsSync(PROFILE)) {
  problems.push(`profile 不存在：${PROFILE}`);
} else {
  const text = fs.readFileSync(PROFILE, 'utf8');
  const bytes = Buffer.byteLength(text);
  notes.push(`profile: ${bytes} 字节`);

  const body = text.replace(/^\s*#.*$/gmu, '').trim();
  if (body === '' || body === '[]') {
    problems.push('profile 是空的（只剩头部注释或 []）——这就是 11-08 起不来的形态');
  }

  if (!/^- id:/mu.test(text)) {
    problems.push('profile 里没有任何 "- id:" 条目，顶层不是条目数组');
  }

  for (const id of REQUIRED_ENTRIES) {
    if (!new RegExp(`^- id:\\s*${id}\\s*$`, 'mu').test(text)) {
      problems.push(`缺少关键条目：${id}`);
    }
  }

  const entryCount = (text.match(/^- id:/gmu) || []).length;
  notes.push(`顶层条目: ${entryCount} 个`);

  const lines = text.split(/\r?\n/u);
  const gatewayProviders = [];
  for (let i = 0; i < lines.length; i += 1) {
    const field = /^\s*baseURL:\s*(\S+)\s*$/u.exec(lines[i]);
    if (!field) continue;
    if (!isGatewayBaseUrl(field[1])) continue;
    const indent = lines[i].length - lines[i].trimStart().length;
    for (let j = i - 1; j >= 0; j -= 1) {
      if (lines[j].trim() === '') continue;
      const upIndent = lines[j].length - lines[j].trimStart().length;
      if (upIndent < indent && /^[\w.-]+:\s*$/u.test(lines[j].trim())) {
        gatewayProviders.push({ name: lines[j].trim().replace(/:$/, ''), baseURL: field[1], line: j, indent: upIndent });
        break;
      }
    }
  }
  if (gatewayProviders.length === 0) {
    problems.push('profile 里没有指向本网关的 provider（v2 应是 baseURL 路径正好为 /v1 的那一段）');
  }

  let readyCount = null;
  let reachable = false;
  try {
    const cfgPath = path.join(os.homedir(), '.dsh', 'cb-dsh', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const base = (cfg.gatewayBase || 'http://127.0.0.1:7801').replace(/\/+$/u, '');
    const response = await fetch(`${base}/api/health`, {
      headers: { Authorization: 'Bearer ' + (cfg.apiToken || '') },
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      const doc = await response.json();
      reachable = true;
      const accounts = Array.isArray(doc.accounts) ? doc.accounts : [];
      readyCount = accounts.filter((item) => item && item.status === 'ready').length;
    }
  } catch {
    reachable = false;
  }

  for (const provider of gatewayProviders) {
    let blockEndAt = lines.length;
    for (let i = provider.line + 1; i < lines.length; i += 1) {
      if (lines[i].trim() === '') continue;
      const indent = lines[i].length - lines[i].trimStart().length;
      if (indent <= provider.indent) { blockEndAt = i; break; }
    }
    const hasModels = lines.slice(provider.line, blockEndAt).some((line) => /^\s*models:\s*$/u.test(line));

    if (hasModels) {
      notes.push(`${provider.name}: ${provider.baseURL}（profile 有 models 段）`);
    } else if (!reachable) {
      notes.push(`${provider.name}: ${provider.baseURL}（网关不可达，无法核对；models 段缺失时由插件自动同步）`);
    } else if (readyCount === 0) {
      notes.push(`${provider.name}: ${provider.baseURL}（还没有 ready 账号，models 段为空是正常的）`);
    } else {
      notes.push(`${provider.name}: ${provider.baseURL}（有 ${readyCount} 个 ready 账号但 profile 没有 models 段）`);
      notes.push('  插件 host 半边每 15 秒会写一次；一直不写就看 ~/.dsh/cb-dsh/plugin-host.log');
    }
  }
}

for (const file of ['client.js', 'index.js']) {
  const full = path.join(PLUGIN_DIR, file);
  if (!fs.existsSync(full)) {
    problems.push(`插件文件缺失：${file}`);
    continue;
  }
  const result = spawnSync(process.execPath, ['--check', full], { encoding: 'utf8' });
  if (result.status === 0) {
    notes.push(`插件 ${file}: 语法 OK（${fs.statSync(full).size} 字节）`);
  } else {
    const detail = (result.stderr || '').split('\n').find((line) => line.trim() !== '') || '未知错误';
    problems.push(`插件 ${file} 语法错误：${detail.trim()}`);
  }
}

const dir = path.dirname(PROFILE);
const backups = fs
  .readdirSync(dir)
  .filter((name) => name.startsWith('cordis.patch.yml.bak'))
  .map((name) => ({ name, size: fs.statSync(path.join(dir, name)).size }))
  .filter((b) => b.size > 1000);
if (backups.length === 0) {
  problems.push('没有有效备份（>1000 字节），出事时没法回滚');
} else {
  notes.push(`有效备份: ${backups.length} 份，最新一份 ${Math.max(...backups.map((b) => b.size))} 字节`);
}

const profilePkgPath = path.join(path.dirname(PROFILE), 'package.json');
if (!fs.existsSync(profilePkgPath)) {
  problems.push('profile 的 package.json 不存在');
} else {
  const pkg = JSON.parse(fs.readFileSync(profilePkgPath, 'utf8'));
  const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
  const localBundles = bundles.filter((name) => typeof name === 'string' && !name.startsWith('@deepseek-ai/'));
  for (const name of localBundles) {
    const dir = path.join(path.dirname(PROFILE), 'node_modules', name);
    const manifest = path.join(dir, 'package.json');
    if (!fs.existsSync(manifest)) {
      problems.push(`bundles 里声明了 ${name}，但 node_modules/${name} 不存在（先 pnpm install）`);
      continue;
    }
    const installed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (installed.name !== name) {
      problems.push(`node_modules/${name}/package.json 的 name 是 "${installed.name}"，和声明不一致`);
      continue;
    }
    const depSpec = pkg.dependencies && pkg.dependencies[name];
    if (!depSpec) {
      problems.push(`package.json 的 dependencies 里没有 ${name}，下次 pnpm install 会移除它`);
    } else if (!fs.existsSync(depSpec.replace(/^file:/u, ''))) {
      problems.push(`dependencies 里的 ${name} 指向的 tarball 不存在：${depSpec}`);
    } else {
      notes.push(`插件 bundle ${name}: 已安装且依赖指向有效`);
    }
  }
}

for (const note of notes) console.log(`  ${note}`);
console.log('');

if (problems.length === 0) {
  console.log('自检通过。可以重启 DSH。');
  process.exit(0);
}

console.log('发现问题：');
for (const p of problems) console.log(`  - ${p}`);
console.log('\n先修上面这些再重启。回滚命令见 cb-gateway/README.md。');
process.exit(1);
