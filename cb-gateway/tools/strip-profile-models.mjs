// 把 DSH profile 里三个 provider 的 `models:` 段删掉。
//
// ⚠️ **这是清理/重置工具，不是常规部署步骤。** 2026-11 一度以为「DSH 在 provider
// 没配 models 时会去 GET <baseURL>/models 自动发现」，于是写了这个脚本来删静态列表。
// 后来实测证伪：qoder 没配 models 段时 DSH 从头到尾没请求过 /qoder/v1/models，
// 模型列表一直是空的。DSH 只从 profile 的 settings 文档读模型。
//
// ⚠️ **v2 下它按 `/<通道>/v1` 找 provider，而那套通道前缀路由已经删了**——所以它
// 在 v2 的 profile（只有一个 `baseURL` 路径正好 `/v1` 的聚合 provider）里找不到
// 任何目标，只会打印「跳过」。留着它只用于：想手工把某个按通道拆开的 v1 provider
// 的 models 段清掉做实验，或者排查那段配置写坏了要重来。v2 日常同步由插件 host
// 半边每 15 秒做，不需要本脚本。
//
// 只删 provider 块里的 `models:` 段，其它字段（baseURL / headers / displayName…）
// 一律原样保留。改前自动备份。
//
// 用法：node tools/strip-profile-models.mjs [--write]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROFILE = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
const WRITE = process.argv.includes('--write');
const PREFIXES = ['/workbuddy', '/trae', '/qoder'];

const indentOf = (line) => (/^\s*/u.exec(line) || [''])[0].length;
const isBlank = (line) => line.trim() === '';

function providerAbove(lines, from, fieldIndent) {
  for (let i = from - 1; i >= 0; i -= 1) {
    if (isBlank(lines[i])) continue;
    if (indentOf(lines[i]) >= fieldIndent) continue;
    const key = /^([\w.-]+):\s*$/u.exec(lines[i].trim());
    return key ? { key: key[1], start: i, indent: indentOf(lines[i]) } : null;
  }
  return null;
}

function blockEnd(lines, from, indent) {
  for (let i = from; i < lines.length; i += 1) {
    if (!isBlank(lines[i]) && indentOf(lines[i]) <= indent) return i;
  }
  return lines.length;
}

let lines = fs.readFileSync(PROFILE, 'utf8').split(/\r?\n/);
const report = [];

for (const prefix of PREFIXES) {
  const needle = `${prefix}/v1`;
  const at = lines.findIndex((line) => /^\s*baseURL:\s*(\S+)\s*$/u.test(line) && line.trim().endsWith(needle));
  if (at < 0) {
    report.push(`${prefix}: profile 里没有 baseURL 指向 ${needle} 的 provider（跳过）`);
    continue;
  }
  const provider = providerAbove(lines, at, indentOf(lines[at]));
  if (!provider) {
    report.push(`${prefix}: 找不到所属 provider（跳过）`);
    continue;
  }
  const end = blockEnd(lines, provider.start + 1, provider.indent);
  let modelsAt = -1;
  let modelsIndent = 0;
  for (let i = provider.start + 1; i < end; i += 1) {
    const m = /^(\s*)models:\s*$/u.exec(lines[i]);
    if (m) {
      modelsAt = i;
      modelsIndent = m[1].length;
      break;
    }
  }
  if (modelsAt < 0) {
    report.push(`${provider.key}: 已经没有 models: 段（跳过）`);
    continue;
  }
  const modelsEnd = blockEnd(lines, modelsAt + 1, modelsIndent);
  const removed = modelsEnd - modelsAt;
  const modelsCount = lines.slice(modelsAt, modelsEnd).filter((l) => /^\s+- id:/u.test(l)).length;
  report.push(`${provider.key}: 删除 models: 段 ${removed} 行（含 ${modelsCount} 个模型）`);
  lines = [...lines.slice(0, modelsAt), ...lines.slice(modelsEnd)];
}

const next = lines.join('\n');
for (const line of report) console.log(`  ${line}`);

if (!WRITE) {
  console.log('\n这是预览。加 --write 才会落盘。');
  process.exit(0);
}

const backup = `${PROFILE}.bak-strip-models-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
fs.copyFileSync(PROFILE, backup);
fs.writeFileSync(PROFILE, next, 'utf8');
console.log(`\n已写入。备份：${path.basename(backup)}`);
console.log(`剩余顶层条目：${(next.match(/^- id:/gmu) || []).length} 个，models: 段 ${(next.match(/^\s*models:\s*$/gmu) || []).length} 处`);
