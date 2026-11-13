import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PROFILE_PATH = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');

const BASE_URL_RE = /^\s*baseURL:\s*(\S+)\s*$/u;
const PROVIDER_KEY_RE = /^([\w.-]+):\s*$/u;
const MODELS_RE = /^(\s*)models:\s*$/u;

export function readProfileLines(file = PROFILE_PATH) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/);
}

function indentOf(line: string) {
  const match = /^\s*/u.exec(line);
  return match ? match[0].length : 0;
}

function providerAbove(lines: string[], fieldIndex: number, fieldIndent: number) {
  for (let i = fieldIndex - 1; i >= 0; i -= 1) {
    if (lines[i].trim() === '') continue;
    if (indentOf(lines[i]) >= fieldIndent) continue;
    const key = PROVIDER_KEY_RE.exec(lines[i].trim());
    return key ? { key: key[1], start: i, indent: indentOf(lines[i]) } : null;
  }
  return null;
}

function blockEnd(lines: string[], from: number, indent: number) {
  for (let i = from; i < lines.length; i += 1) {
    if (lines[i].trim() !== '' && indentOf(lines[i]) <= indent) return i;
  }
  return lines.length;
}

export function locateProvider(lines: string[], prefix: string) {
  const needle = `${prefix}/v1`;
  for (let i = 0; i < lines.length; i += 1) {
    const field = BASE_URL_RE.exec(lines[i]);
    if (!field || !field[1].endsWith(needle)) continue;
    const provider = providerAbove(lines, i, indentOf(lines[i]));
    if (!provider) continue;
    return { ...provider, end: blockEnd(lines, provider.start + 1, provider.indent) };
  }
  throw new Error(`profile 里没有 baseURL 指向 ${needle} 的 provider`);
}

export function locateModels(lines: string[], prefix: string) {
  const provider = locateProvider(lines, prefix);
  for (let i = provider.start + 1; i < provider.end; i += 1) {
    const match = MODELS_RE.exec(lines[i]);
    if (!match) continue;
    const modelsIndent = match[1].length;
    return {
      provider: provider.key,
      listStart: i,
      listEnd: blockEnd(lines, i + 1, modelsIndent),
      itemIndent: modelsIndent + 2,
      fieldIndent: modelsIndent + 4,
    };
  }
  throw new Error(`provider ${provider.key} 里没有 models: 列表`);
}

export interface ModelsRange {
  provider: string;
  listStart: number;
  listEnd: number;
  itemIndent: number;
  fieldIndent: number;
}

export function parseModels(lines: string[], range: ModelsRange) {
  const itemRe = new RegExp(`^\\s{${range.itemIndent}}- id:\\s*(\\S+)\\s*$`, 'u');
  const itemFieldRe = new RegExp(`^\\s{${range.fieldIndent}}(\\w+):\\s*(.*?)\\s*$`, 'u');
  const models = [];
  let current: any = null;

  for (let i = range.listStart + 1; i < range.listEnd; i += 1) {
    const idMatch = itemRe.exec(lines[i]);
    if (idMatch) {
      current = { id: idMatch[1], name: '', contextWindow: null, maxTokens: null, line: i };
      models.push(current);
      continue;
    }
    if (!current) continue;

    const field = itemFieldRe.exec(lines[i]);
    if (!field) continue;

    const [, key, rawValue] = field;
    const value = rawValue.replace(/^"|"$/gu, '');

    if (key === 'name') current.name = value;
    else if (key === 'contextWindow') current.contextWindow = toNumber(value);
    else if (key === 'maxTokens') current.maxTokens = toNumber(value);
  }
  return models;
}

function toNumber(value: string) {
  return /^\d+$/u.test(value) ? Number(value) : null;
}

export function writeProfileLines(lines: string[], file = PROFILE_PATH) {
  const backup = file + '.bak-' + new Date().toISOString().replace(/[:.]/gu, '-');
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return path.basename(backup);
}
