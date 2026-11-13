import fs from 'node:fs';
import path from 'node:path';

import { STATE_DIR } from '../shared/paths.ts';
import { writeFileAtomic } from '../shared/atomic-write.ts';

const FILE = path.join(STATE_DIR, 'model-cooldown.json');

export const DEFAULT_MODEL_COOLDOWN_MS = 5 * 60 * 1000;

export interface ModelCooldown {
  model: string;
  until: number;
  message: string | null;
}

interface Stored {
  until?: unknown;
  message?: unknown;
}

type Doc = Record<string, Record<string, Stored>>;

function readDoc(): Doc {
  try {
    const doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Doc) : {};
  } catch {
    return {};
  }
}

function writeDoc(doc: Doc): void {
  try {
    writeFileAtomic(FILE, `${JSON.stringify(doc, null, 2)}\n`);
  } catch {
  }
}

function prune(doc: Doc, now: number): { doc: Doc; changed: boolean } {
  let changed = false;
  for (const [accountId, models] of Object.entries(doc)) {
    if (!models || typeof models !== 'object') {
      delete doc[accountId];
      changed = true;
      continue;
    }
    for (const [model, entry] of Object.entries(models)) {
      const until = Number(entry && entry.until);
      if (!Number.isFinite(until) || until <= now) {
        delete models[model];
        changed = true;
      }
    }
    if (Object.keys(models).length === 0) {
      delete doc[accountId];
      changed = true;
    }
  }
  return { doc, changed };
}

export function modelCooldownOf(accountId: string, model: string): ModelCooldown | null {
  const now = Date.now();
  const raw = readDoc();
  const entry = raw[accountId]?.[model];
  if (!entry) {
    return null;
  }
  const until = Number(entry.until);
  if (!Number.isFinite(until) || until <= now) {
    const { doc, changed } = prune(raw, now);
    if (changed) writeDoc(doc);
    return null;
  }
  return { model, until, message: typeof entry.message === 'string' ? entry.message : null };
}

export function markModelCooldown(
  accountId: string,
  model: string,
  until: number = Date.now() + DEFAULT_MODEL_COOLDOWN_MS,
  message: string | null = null,
): ModelCooldown {
  const doc = readDoc();
  const bucket = (doc[accountId] ||= {});
  const previous = Number(bucket[model]?.until);
  const next = Number.isFinite(previous) && previous > until ? previous : until;
  bucket[model] = { until: next, message };
  writeDoc(doc);
  return { model, until: next, message };
}

export function clearModelCooldown(accountId: string, model: string): boolean {
  const doc = readDoc();
  if (!doc[accountId]?.[model]) return false;
  delete doc[accountId][model];
  if (Object.keys(doc[accountId]).length === 0) delete doc[accountId];
  writeDoc(doc);
  return true;
}

export function listModelCooldowns(accountId: string): ModelCooldown[] {
  const now = Date.now();
  const doc = readDoc();
  const models = doc[accountId] || {};
  const out: ModelCooldown[] = [];
  for (const [model, entry] of Object.entries(models)) {
    const until = Number(entry && entry.until);
    if (Number.isFinite(until) && until > now) {
      out.push({ model, until, message: typeof entry.message === 'string' ? entry.message : null });
    }
  }
  return out.sort((a, b) => a.until - b.until);
}

export function resetModelCooldownsForTests(): void {
  try {
    fs.rmSync(FILE, { force: true });
  } catch {
  }
}
