import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './shared/paths.ts';
import { writeFileAtomic } from './shared/atomic-write.ts';

const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

const DEFAULTS = {
  host: '127.0.0.1',
  port: 7801,
  defaultContextWindow: 200000,
  defaultMaxTokens: 32768,
  verbose: true,
  checkinTime: '10:05',
};

export type ConfigDoc = Record<string, any>;

function isPlainObject(value: unknown): value is ConfigDoc {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function readConfigDoc(): ConfigDoc {
  try {
    const doc = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return isPlainObject(doc) ? doc : {};
  } catch {
    return {};
  }
}

function loadConfig() {
  return { ...DEFAULTS, ...readConfigDoc() };
}

export const config = loadConfig();

export function mutateConfig(mutator: (doc: ConfigDoc) => void): void {
  const doc = readConfigDoc();
  mutator(doc);
  writeFileAtomic(CONFIG_PATH, `${JSON.stringify(doc, null, 2)}\n`);
}

export function isValidCheckinTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(value);
  if (!match) return false;
  return true;
}

export function updateConfig(patch: Record<string, unknown>): { ok: boolean; error?: string } {
  const allowed = new Set(['checkinTime']);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) return { ok: false, error: `不允许改配置键 ${key}` };
  }
  if ('checkinTime' in patch && !isValidCheckinTime(patch.checkinTime)) {
    return { ok: false, error: '签到时间必须是 HH:MM（24 小时制）' };
  }
  try {
    mutateConfig((doc) => {
      Object.assign(doc, patch);
    });
  } catch (error: any) {
    return { ok: false, error: error?.message || '写配置失败' };
  }
  Object.assign(config, patch);
  return { ok: true };
}
