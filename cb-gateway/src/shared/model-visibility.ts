import { mutateConfig, readConfigDoc } from '../config.ts';

const KEY = 'visibleModels';
const LISTED_KEY = 'visibleChannels';

function isPlainObject(value: any) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanIds(value: any): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const id of value) {
    if (typeof id === 'string' && id !== '') seen.add(id);
  }
  return [...seen];
}

function writeConfig(mutator: (doc: Record<string, any>) => void): void {
  mutateConfig(mutator);
}

export function visibleModels(): Record<string, string[]> {
  const raw = readConfigDoc()[KEY];
  if (!isPlainObject(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [channelId, value] of Object.entries(raw)) {
    if (Array.isArray(value)) out[channelId] = cleanIds(value);
  }
  return out;
}

export function visibleFor(channelId: string): string[] | null {
  return visibleModels()[channelId] ?? null;
}

export function isListed(channelId: string): boolean {
  const raw = readConfigDoc()[LISTED_KEY];
  if (!isPlainObject(raw)) return true;
  return raw[channelId] !== false;
}

export function setListed(channelId: string, listed: boolean): void {
  writeConfig((doc) => {
    const current = isPlainObject(doc[LISTED_KEY]) ? { ...doc[LISTED_KEY] } : {};
    if (listed) delete current[channelId];
    else current[channelId] = false;
    if (Object.keys(current).length === 0) delete doc[LISTED_KEY];
    else doc[LISTED_KEY] = current;
  });
}

export function setVisibleFor(channelId: string, ids: string[] | null): void {
  writeConfig((doc) => {
    const current = isPlainObject(doc[KEY]) ? { ...doc[KEY] } : {};
    if (ids === null) delete current[channelId];
    else current[channelId] = cleanIds(ids);
    if (Object.keys(current).length === 0) delete doc[KEY];
    else doc[KEY] = current;
  });
}

export function filterModels<T extends { id: string }>(channelId: string, models: T[]): T[] {
  if (!isListed(channelId)) return [];
  const ids = visibleFor(channelId);
  if (ids === null) return models;
  const byId = new Map(models.map((model) => [model.id, model]));
  const out: T[] = [];
  for (const id of ids) {
    const model = byId.get(id);
    if (model) out.push(model);
  }
  return out;
}
