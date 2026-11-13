import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROFILE = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
const PLUGIN_CONFIG = path.join(os.homedir(), '.dsh', 'cb-dsh', 'config.json');
const WRITE = process.argv.includes('--write');
const channels = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (channels.length === 0) {
  console.error('用法: node tools/sync-profile-models.mjs <channel> [<channel>...] [--write]');
  process.exit(1);
}

const REASONING_EFFORTS = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' };

function readAuth() {
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(PLUGIN_CONFIG, 'utf8'));
  } catch {
    config = {};
  }
  const base = (config.gatewayBase || 'http://127.0.0.1:7801').replace(/\/+$/u, '');
  return { base, auth: 'Bearer ' + (config.apiToken || '') };
}

async function fetchModels(base, auth, channel) {
  const response = await fetch(`${base}/${channel}/v1/models`, {
    headers: { Authorization: auth },
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`${channel}: HTTP ${response.status}`);
  const doc = await response.json();
  const data = Array.isArray(doc.data) ? doc.data : [];
  return data
    .filter((m) => m && typeof m.id === 'string' && m.id)
    .map((m) => ({
      id: m.id,
      name: typeof m.name === 'string' && m.name ? m.name : m.id,
      contextWindow: Number.isFinite(m.context_length) ? m.context_length : null,
      maxTokens: Number.isFinite(m.max_output_tokens) ? m.max_output_tokens : null,
      reasoning: m.reasoning === true,
      input: Array.isArray(m.input) && m.input.length > 0 ? m.input : null,
    }));
}

async function fetchHealth(base, auth) {
  const response = await fetch(`${base}/api/health`, {
    headers: { Authorization: auth },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`/api/health: HTTP ${response.status}`);
  return await response.json();
}

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

function parseEntries(lines, start, end, itemIndent) {
  const entries = [];
  let current = null;
  let skipDeeperThan = Infinity;
  for (let i = start; i < end; i += 1) {
    if (isBlank(lines[i])) continue;
    const indent = indentOf(lines[i]);
    if (indent > skipDeeperThan) continue;
    skipDeeperThan = Infinity;

    const idMatch = new RegExp(`^\\s{${itemIndent}}- id:\\s*(\\S+)\\s*$`, 'u').exec(lines[i]);
    if (idMatch) {
      current = { id: idMatch[1], extra: [] };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    const field = /^\s+([\w$.-]+):/u.exec(lines[i]);
    const key = field ? field[1] : '';
    if (['name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts'].includes(key)) {
      skipDeeperThan = indent;
      continue;
    }
    current.extra.push(lines[i]);
  }
  return entries;
}

function replaceModels(lines, at, models) {
  const provider = providerAbove(lines, at, indentOf(lines[at]));
  const end = blockEnd(lines, provider.start + 1, provider.indent);

  let modelsAt = -1;
  let modelsIndent = 0;
  for (let i = provider.start + 1; i < end; i += 1) {
    const m = /^(\s*)models:\s*(?:\[\s*\])?\s*$/u.exec(lines[i]);
    if (m) {
      modelsAt = i;
      modelsIndent = m[1].length;
      break;
    }
  }

  const fieldIndent = indentOf(lines[at]);
  const itemIndent = fieldIndent + 2;
  const keyIndent = fieldIndent + 4;
  const pad = (n) => ' '.repeat(n);

  let preserved = [];
  let insertAt = modelsAt >= 0 ? modelsAt : end;
  let next = lines;
  if (modelsAt >= 0) {
    const modelsEnd = blockEnd(lines, modelsAt + 1, modelsIndent);
    preserved = parseEntries(lines, modelsAt + 1, modelsEnd, itemIndent);
    next = [...lines.slice(0, modelsAt), ...lines.slice(modelsEnd)];
    insertAt = modelsAt;
  }
  const byId = new Map(preserved.map((entry) => [entry.id, entry]));

  const block = models.length === 0 ? [`${pad(fieldIndent)}models: []`] : [`${pad(fieldIndent)}models:`];
  let withEffort = 0;
  for (const model of models) {
    const old = byId.get(model.id);
    block.push(`${pad(itemIndent)}- id: ${model.id}`);
    block.push(`${pad(keyIndent)}name: ${JSON.stringify(model.name)}`);
    if (model.contextWindow !== null) block.push(`${pad(keyIndent)}contextWindow: ${model.contextWindow}`);
    if (model.maxTokens !== null) block.push(`${pad(keyIndent)}maxTokens: ${model.maxTokens}`);

    if (model.input) {
      block.push(`${pad(keyIndent)}input:`);
      for (const modality of model.input) block.push(`${pad(keyIndent + 2)}- ${modality}`);
    }

    if (model.reasoning) {
      block.push(`${pad(keyIndent)}reasoningEfforts:`);
      for (const [level, value] of Object.entries(REASONING_EFFORTS)) {
        block.push(`${pad(keyIndent + 2)}${level}: ${value}`);
      }
      withEffort += 1;
    }

    if (old) for (const line of old.extra) block.push(line);
  }

  return { lines: [...next.slice(0, insertAt), ...block, ...next.slice(insertAt)], withEffort };
}

const { base, auth } = readAuth();
console.log(`网关 ${base}（${auth.startsWith('Basic') ? '账号密码' : 'token'}）`);

const healthDoc = await fetchHealth(base, auth);
const health = healthDoc && healthDoc.channels && typeof healthDoc.channels === 'object' ? healthDoc.channels : {};

let lines = fs.readFileSync(PROFILE, 'utf8').split(/\r?\n/);

for (const channel of channels) {
  const info = health[channel] || {};
  const listed = info.listed !== false;

  let models = [];
  if (listed) {
    models = await fetchModels(base, auth, channel);
    if (models.length === 0) {
      console.log(`  ${channel}: 网关返回 0 个模型，跳过`);
      continue;
    }
  } else {
    console.log(`  ${channel}: 模型列表已关闭，清空 profile 的 models 段`);
  }

  const needle = `/${channel}/v1`;
  const at = lines.findIndex((line) => /^\s*baseURL:\s*(\S+)\s*$/u.test(line) && line.trim().endsWith(needle));
  if (at < 0) {
    console.log(`  ${channel}: profile 里找不到 baseURL 以 ${needle} 结尾的 provider，跳过`);
    continue;
  }
  const replaced = replaceModels(lines, at, models);
  lines = replaced.lines;
  console.log(
    `  ${channel}: ${models.length} 个模型${models.length === 0 ? '' : `（其中 ${replaced.withEffort} 个带思考档位）`}`,
  );
}

if (!WRITE) {
  console.log('\n预览模式。加 --write 才落盘。');
  process.exitCode = 0;
} else {
  const backup = `${PROFILE}.bak-sync-models-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
  fs.copyFileSync(PROFILE, backup);
  fs.writeFileSync(PROFILE, lines.join('\n'), 'utf8');
  console.log(`\n已写入。备份：${path.basename(backup)}`);
}

