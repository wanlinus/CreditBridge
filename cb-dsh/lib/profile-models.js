import fs from 'node:fs';

import { blockEnd, indentOf, isBlank, providerAbove } from './yaml-lines.js';

const DEFAULT_REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'];

function parseEntries(lines, start, end, itemIndent) {
  const entries = [];
  let current = null;
  let skipDeeperThan = Infinity;
  const itemRe = new RegExp(`^\\s{${itemIndent}}- id:\\s*(\\S+)\\s*$`, 'u');
  for (let i = start; i < end; i += 1) {
    if (isBlank(lines[i])) continue;
    const indent = indentOf(lines[i]);
    if (indent > skipDeeperThan) continue;
    skipDeeperThan = Infinity;

    const idMatch = itemRe.exec(lines[i]);
    if (idMatch) {
      current = { id: idMatch[1], extra: [] };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    const field = /^\s+([\w$.-]+):/u.exec(lines[i]);
    const key = field ? field[1] : '';
    if (['name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts'].includes(key)) {
      if (key === 'contextWindow') {
        const value = /^\s+contextWindow:\s*(\d+)\s*$/u.exec(lines[i]);
        if (value) current.contextWindow = Number(value[1]);
      }
      skipDeeperThan = indent;
      continue;
    }
    current.extra.push(lines[i]);
  }
  return entries;
}

export function normalizeModel(model) {
  return {
    id: model.id,
    name: typeof model.name === 'string' && model.name ? model.name : model.id,
    contextWindow: Number.isFinite(model.context_length) ? model.context_length : null,
    maxTokens: Number.isFinite(model.max_output_tokens) ? model.max_output_tokens : null,
    reasoning: model.reasoning === true,
    reasoningEfforts:
      Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length > 0
        ? model.reasoningEfforts
        : null,
    input: Array.isArray(model.input) && model.input.length > 0 ? model.input : null,
  };
}

export function applyAggregateModels(lines, models) {
  const at = lines.findIndex((line) => {
    const match = /^\s*baseURL:\s*(\S+)\s*$/u.exec(line);
    if (!match) return false;
    try {
      return new URL(match[1]).pathname === '/v1';
    } catch {
      return false;
    }
  });
  if (at < 0) return { lines, found: false, changed: false };
  return applyModelsAt(lines, at, models);
}

function applyModelsAt(lines, at, models) {
  const provider = providerAbove(lines, at, indentOf(lines[at]));
  if (!provider) return { lines, found: false, changed: false };
  const end = blockEnd(lines, provider.start + 1, provider.indent);

  let modelsAt = -1;
  let modelsIndent = 0;
  for (let i = provider.start + 1; i < end; i += 1) {
    const match = /^(\s*)models:\s*(?:\[\s*\])?\s*$/u.exec(lines[i]);
    if (match) {
      modelsAt = i;
      modelsIndent = match[1].length;
      break;
    }
  }

  const fieldIndent = indentOf(lines[at]);
  const itemIndent = fieldIndent + 2;
  const keyIndent = fieldIndent + 4;
  const pad = (n) => ' '.repeat(n);

  let preserved = [];
  let insertAt = modelsAt >= 0 ? modelsAt : end;
  let rest = lines;
  if (modelsAt >= 0) {
    const modelsEnd = blockEnd(lines, modelsAt + 1, modelsIndent);
    preserved = parseEntries(lines, modelsAt + 1, modelsEnd, itemIndent);
    rest = [...lines.slice(0, modelsAt), ...lines.slice(modelsEnd)];
    insertAt = modelsAt;
  }
  const byId = new Map(preserved.map((entry) => [entry.id, entry]));

  const block = models.length === 0 ? [`${pad(fieldIndent)}models: []`] : [`${pad(fieldIndent)}models:`];
  for (const model of models) {
    block.push(`${pad(itemIndent)}- id: ${model.id}`);
    block.push(`${pad(keyIndent)}name: ${JSON.stringify(model.name)}`);

    const existing = byId.get(model.id);
    const stored = existing && Number.isFinite(existing.contextWindow) ? existing.contextWindow : null;
    const contextWindow =
      model.contextWindow === null
        ? stored
        : stored === null
          ? model.contextWindow
          : Math.min(stored, model.contextWindow);
    if (contextWindow !== null) block.push(`${pad(keyIndent)}contextWindow: ${contextWindow}`);

    if (model.maxTokens !== null) block.push(`${pad(keyIndent)}maxTokens: ${model.maxTokens}`);

    if (model.input) {
      block.push(`${pad(keyIndent)}input:`);
      for (const modality of model.input) block.push(`${pad(keyIndent + 2)}- ${modality}`);
    }

    if (model.reasoning) {
      const efforts = Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length > 0
        ? model.reasoningEfforts
        : DEFAULT_REASONING_EFFORTS;
      block.push(`${pad(keyIndent)}reasoningEfforts:`);
      for (const level of efforts) {
        const key = level === 'none' || level === 'off' ? 'off' : level;
        if (key === 'off') {
          block.push(`${pad(keyIndent + 2)}off: null`);
        } else {
          block.push(`${pad(keyIndent + 2)}${key}: ${level}`);
        }
      }
    }

    const old = byId.get(model.id);
    if (old) for (const line of old.extra) block.push(line);
  }

  const next = [...rest.slice(0, insertAt), ...block, ...rest.slice(insertAt)];
  return { lines: next, found: true, changed: next.join('\n') !== lines.join('\n') };
}

export async function syncProfileModels(options) {
  const { profilePath, base, auth, fetchImpl = fetch, timeoutMs = 20000, log = () => {} } = options;
  const headers = { Accept: 'application/json' };
  if (auth) headers.Authorization = auth;

  const response = await fetchImpl(`${base}/api/models`, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`/api/models HTTP ${response.status}`);
  const doc = await response.json();
  const models = (Array.isArray(doc.data) ? doc.data : [])
    .filter((model) => model && typeof model.id === 'string' && model.id)
    .map(normalizeModel);

  if (models.length === 0) {
    let allChannelsOff = false;
    try {
      const healthResponse = await fetchImpl(`${base}/api/health`, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (healthResponse.ok) {
        const health = await healthResponse.json();
        const channels = health && health.channels && typeof health.channels === 'object' ? health.channels : null;
        const entries = channels ? Object.values(channels) : [];
        allChannelsOff = entries.length > 0 && entries.every((item) => item && item.listed === false);
      }
    } catch {
      allChannelsOff = false;
    }
    if (!allChannelsOff) {
      log('模型同步：网关返回 0 个模型（账号没登录 / key 没权限？），跳过');
      return { models: 0, wrote: false, backup: null, reason: 'empty' };
    }
    log('模型同步：所有通道都关掉了，写空 models 段');
  }

  const lines = fs.readFileSync(profilePath, 'utf8').split(/\r?\n/u);
  const applied = applyAggregateModels(lines, models);
  if (!applied.found) {
    log("模型同步：profile 里没有 baseURL 路径为 /v1 的 provider，跳过");
    return { models: models.length, wrote: false, backup: null, reason: 'no-provider' };
  }
  if (!applied.changed) {
    return { models: models.length, wrote: false, backup: null, reason: 'unchanged' };
  }

  const backup = `${profilePath}.bak-model-sync-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
  fs.copyFileSync(profilePath, backup);
  fs.writeFileSync(profilePath, applied.lines.join('\n'), 'utf8');
  log(`模型同步：写入 ${models.length} 个模型，备份 ${backup}`);
  return { models: models.length, wrote: true, backup, reason: 'written' };
}
