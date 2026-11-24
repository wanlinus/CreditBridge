// 把网关 `/v1/models` 的模型列表同步进 DSH profile 的 `models:` 段。
//
// 两个原则：
//
// 1. **只写网关知道的东西，其余字段原样保留。**
//    2026-11 踩过：第一版整段重写，只写 id/name/contextWindow/maxTokens，结果把
//    `input` 和 `reasoningEfforts` 全丢了——DSH 的思考强度选择器直接消失。现在按
//    id 合并：已知字段更新，未知字段逐行保留。
//
// 2. **能力数据驱动，不手写。**
//    `reasoningEfforts` / `input` 原来是人工填的，57 个模型填不过来。现在网关在
//    `/v1/models` 里报 `reasoning` / `input`，这里据它生成。上游没报的（比如
//    Qoder 的 CLI 目录）就沿用 profile 里已有的值，没有就不写。
//
// 认证：网关现在所有接口都要凭据，且只认 `apiToken`（`Authorization: Bearer sk-…`）。
// 凭据从插件配置（~/.dsh/cb-dsh/config.json）读；Basic 账号密码在 E 阶段删了，
// 插件配置里也没有 `username` / `password` 这两个字段。
//
// ⚠️ **这个脚本是 v1 形态的历史工具**：它按通道分别拉 `<通道>/v1/models`、按
// `/<通道>/v1` 定位 profile 里的 provider——那套通道前缀路由在 v2 已删（现在会 404）。
// v2 的模型同步由插件 host 半边每 15 秒做一次（拉 `/api/models` 写聚合 provider），
// 日常不需要它。本脚本只在「不想开 DSH、只想一次性写 profile」时才有意义，
// 且需要 profile 里还留着 v1 形态的按通道 provider 条目。
//
// 用法：node tools/sync-profile-models.mjs <channel> [<channel>...] [--write]
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

/** 思考档位。值域来自 DSH 的 THINKING_LEVELS，取常用的四档，和以前手写的保持一致。 */
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

/**
 * `/api/health` 的完整响应。
 *
 * 只用来拿每个通道的 `listed`（模型列表总闸）。v2 的 `/api/health` 没有 v1 那套
 * `aggregate` 键，所以「聚合 provider 那一段」在本脚本里**没有实现**——profile 里
 * 那个 `baseURL` 路径正好 `/v1` 的 provider 由插件 host 半边每 15 秒同步，不归这里管。
 */
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

/**
 * 把一个 `models:` 段解析成 [{ id, extra: [其余字段的原始行] }]。
 *
 * `input:` / `reasoningEfforts:` 这两块由脚本重新生成，所以**连同它们的子行一起
 * 跳过**——只跳过父行的话，子行（`- text`、`low: low`）会被当成"要保留的字段"，
 * 结果是重复输出，`- text` 那种还会直接产出非法 YAML。
 */
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

/**
 * 把 `at`（baseURL 那一行）所属 provider 的 `models:` 段换成 `models`。
 *
 * 按通道的三段和聚合那一段共用它，区别只在怎么定位 `at`。
 *
 * @returns {{lines: string[], withEffort: number}} 新的行数组，以及其中带思考档位的模型数
 */
function replaceModels(lines, at, models) {
  const provider = providerAbove(lines, at, indentOf(lines[at]));
  const end = blockEnd(lines, provider.start + 1, provider.indent);

  // 定位/删除现有 models: 段，同时把已有条目的额外字段捞出来。
  // `[]` 也要认——通道关掉时写的是行内 `models: []`，认不出来会每次都重写一遍。
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

    // input：网关报了就用网关的；没报（比如 Qoder 的 CLI 目录）就不写这一项。
    if (model.input) {
      block.push(`${pad(keyIndent)}input:`);
      for (const modality of model.input) block.push(`${pad(keyIndent + 2)}- ${modality}`);
    }

    // reasoningEfforts：网关说支持推理就写标准四档。上游没报能力时，若 profile 里
    // 本来有就保留（下面 extra 会带回去），没有就不写。
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
// `channels` 和 `aggregate` 平级；两者都要，前者按通道写，后者写聚合那一段。
const health = healthDoc && healthDoc.channels && typeof healthDoc.channels === 'object' ? healthDoc.channels : {};

let lines = fs.readFileSync(PROFILE, 'utf8').split(/\r?\n/);

for (const channel of channels) {
  const info = health[channel] || {};
  // 面板上每个通道有个「模型列表」总开关。关掉的通道要写空的 `models: []`——
  // 那是用户的明确意图；而「网关回了 0 个模型」多半是没登录，跳过才对。
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

// 注意：v2 的网关只有 `/api/models` 一个聚合入口，profile 里也只有一个
// `baseURL` 路径正好 `/v1` 的 provider。那段由插件 host 半边每 15 秒同步，
// 本脚本不碰它（v1 时代这里是「聚合 provider」分支，读的 `healthDoc.aggregate`
// 键在 v2 已删除，属死代码，已移除）。

if (!WRITE) {
  console.log('\n预览模式。加 --write 才落盘。');
  // 用 exitCode 而不是 process.exit()：这脚本用了 fetch，Windows 上 Node 收尾时
  // 如果硬退会撞 libuv 的 async handle 断言（`Assertion failed: !(handle->flags &
  // UV_HANDLE_CLOSING)`），退出码变成 1，看起来像脚本失败。
  process.exitCode = 0;
} else {
  const backup = `${PROFILE}.bak-sync-models-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
  fs.copyFileSync(PROFILE, backup);
  fs.writeFileSync(PROFILE, lines.join('\n'), 'utf8');
  console.log(`\n已写入。备份：${path.basename(backup)}`);
}

