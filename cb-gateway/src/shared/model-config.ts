import {
  PROFILE_PATH,
  locateModels,
  parseModels,
  readProfileLines,
  writeProfileLines,
  type ModelsRange,
} from './profile-yaml.ts';

export { PROFILE_PATH };

const MIN_CONTEXT = 8000;
const MAX_CONTEXT = 2000000;
const MIN_OUTPUT = 256;

export function readModelConfig(prefix: string) {
  const lines = readProfileLines();
  return parseModels(lines, locateModels(lines, prefix));
}

function assertInRange(id: any, field: any, value: any, min: any, max: any) {
  if (!Number.isFinite(value)) throw new Error(`${id}: ${field} must be a number`);
  const rounded = Math.round(value);
  if (rounded < min || rounded > max) {
    throw new Error(`${id}: ${field} ${value} out of range (${min}..${max})`);
  }
  return rounded;
}

export function writeModelConfig(prefix: string, updates: any) {
  const lines = readProfileLines();
  const range: ModelsRange = locateModels(lines, prefix);
  const idRe = new RegExp(`^\\s{${range.itemIndent}}- id:\\s*(\\S+)\\s*$`, 'u');
  const fieldRe = new RegExp(`^\\s{${range.fieldIndent}}(\\w+):\\s*(\\d+)\\s*$`, 'u');

  const wanted = new Map();
  for (const update of updates) {
    if (update && typeof update.id === 'string') wanted.set(update.id, update);
  }

  const changed = [];
  let currentId = null;
  let pending = null;

  for (let i = range.listStart + 1; i < range.listEnd; i += 1) {
    const idMatch = idRe.exec(lines[i]);
    if (idMatch) {
      currentId = idMatch[1];
      pending = wanted.has(currentId) ? wanted.get(currentId) : null;
      continue;
    }
    if (!currentId || !pending) continue;

    const fieldMatch = fieldRe.exec(lines[i]);
    if (!fieldMatch) continue;

    const [, field, rawValue] = fieldMatch;
    if (field !== 'contextWindow' && field !== 'maxTokens') continue;
    if (typeof pending[field] !== 'number') continue;

    const [min, max] = field === 'contextWindow' ? [MIN_CONTEXT, MAX_CONTEXT] : [MIN_OUTPUT, MAX_CONTEXT];
    const next = assertInRange(currentId, field, pending[field], min, max);
    const from = Number(rawValue);
    if (from !== next) {
      lines[i] = lines[i].replace(/:\s*\d+\s*$/u, ': ' + next);
      changed.push({ id: currentId, field, from, to: next });
    }
  }

  if (changed.length === 0) return { changed, backup: null };

  const backup = writeProfileLines(lines);

  const reloadedLines = readProfileLines();
  const reloaded = parseModels(reloadedLines, locateModels(reloadedLines, prefix));
  if (reloaded.length === 0) throw new Error('profile rewrite verification failed (no models parsed back)');

  return { changed, backup };
}
