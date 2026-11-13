import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { ModelInfo } from '../../types.ts';
import { STATE_DIR } from '../../shared/paths.ts';
import { CLI_CONFIG_DIR, ensureCli } from './cli.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRICE_FACTORS_PATH = path.join(__dirname, 'price-factors.json');

const CACHE_PATH = path.join(STATE_DIR, 'qoder-models.json');
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const LIST_TIMEOUT_MS = 60 * 1000;

let logSink: any = null;
export function setModelsLogger(fn: any) {
  logSink = fn;
}function log(...args: unknown[]) {
  if (logSink) logSink(`[qoder-models] ${args.join(' ')}`);
}

interface ModelCache {
  fetchedAt: number;
  models: string[];
}

function readCache(): ModelCache | null {
  try {
    const doc = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (!doc || !Array.isArray(doc.models) || doc.models.length === 0) return null;
    const models = doc.models.filter((m: any) => typeof m === 'string' && m.trim() !== '');
    if (models.length === 0) return null;
    return { fetchedAt: Number(doc.fetchedAt) || 0, models };
  } catch {
    return null;
  }
}

function writeCache(models: string[]) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify({ fetchedAt: Date.now(), models }, null, 2));
  } catch (error: any) {
    log(`模型缓存写入失败：${error.message}`);
  }
}

function isFresh(cache: ModelCache | null): boolean {
  if (!cache) return false;
  return Date.now() - cache.fetchedAt < CACHE_TTL_MS;
}

export function cleanStderr(text: string): string {  return text
    .replace(/\u001b\[[0-9;]*[A-Za-z]/gu, '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => {
      if (line === '') return false;
      if (/^\(node:\d+\)/u.test(line)) return false;
      if (/^\(Use `node .*warning was created\)$/u.test(line)) return false;
      if (/(DeprecationWarning|ExperimentalWarning):/u.test(line)) return false;
      return true;
    })
    .join(' ')
    .trim();
}

export async function fetchModelsFromCli(): Promise<string[]> {
  const entry = await ensureCli();
  return new Promise<string[]>((resolve, reject) => {
    const child = spawn(process.execPath, [entry, '--list-models'], {
      env: {
        ...process.env,
        QODERCN_PERSONAL_ACCESS_TOKEN: '',
        QODERCN_CONFIG_DIR: CLI_CONFIG_DIR,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
      }
      fn();
    };

    child.stdout.on('data', (d) => (out += d.toString('utf8')));
    child.stderr.on('data', (d) => (err += d.toString('utf8')));

    child.on('error', (error) => finish(() => reject(error)));
    child.on('exit', (code) => {
      finish(() => {
        const models = parseModelList(out);
        if (models.length === 0) {
          const reason = cleanStderr(err).slice(-200);
          reject(new Error(`--list-models 没有给出任何模型（code=${code}）${reason}`));
          return;
        }
        resolve(models);
      });
    });

    const timer = setTimeout(() => {
      finish(() => reject(new Error('--list-models 超时')));
    }, LIST_TIMEOUT_MS);
    timer.unref?.();
  });
}

export function parseModelList(text: string): string[] {
  const models: string[] = [];
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === '') continue;
    const firstColumn = line.split(/\s{2,}/u)[0].trim();
    if (firstColumn === '') continue;
    if (firstColumn.toUpperCase() === 'MODEL') continue;
    if (!models.includes(firstColumn)) models.push(firstColumn);
  }
  return models;
}

export async function getModelNames(): Promise<string[]> {
  const cache = readCache();
  if (cache) {
    if (!isFresh(cache)) refreshInBackground('cache stale');
    return cache.models;
  }
  const models = await fetchModelsFromCli();
  writeCache(models);
  log(`模型名单已缓存 ${models.length} 个`);
  return models;
}

let refreshing = false;
function refreshInBackground(reason: string) {
  if (refreshing) return;
  refreshing = true;
  fetchModelsFromCli()
    .then((models) => {
      writeCache(models);
      log(`后台刷新模型名单 ${models.length} 个（${reason}）`);
    })
    .catch((error) => log(`后台刷新失败（${reason}）：${error.message}`))
    .finally(() => {
      refreshing = false;
    });
}

export function maybeRefreshAfterChat() {
  const cache = readCache();
  if (!cache) {
    refreshInBackground('chat 后无缓存');
    return;
  }
  if (Date.now() - cache.fetchedAt > CACHE_TTL_MS / 2) refreshInBackground('chat 后缓存偏旧');
}

export function buildModelList(models: string[], defaultContextWindow: number, defaultMaxTokens: number): ModelInfo[] {
  const rates = readPriceFactors();
  return models.map((name) => {
    const known = rates.find((item) => item.displayName.toLowerCase() === name.toLowerCase());
    const displayName = known ? `${name} · ${known.priceFactor.toFixed(2)}x` : name;
    return {
      id: name,
      object: 'model',
      name: displayName,
      context_length: known && known.maxInputTokens > 0 ? known.maxInputTokens : defaultContextWindow,
      max_output_tokens: defaultMaxTokens,
      ...(known
        ? {
            reasoning: known.canThink,
            ...(known.canThink && known.efforts.length > 0
              ? {
                  reasoningEfforts: [...(known.canDisableThinking ? ['none'] : []), ...known.efforts],
                  ...(known.defaultEffort ? { defaultReasoningEffort: known.defaultEffort } : {}),
                }
              : {}),
            input: known.isVision ? ['text', 'image'] : ['text'],
          }
        : {}),
    };
  });
}

interface PriceFactor {
  displayName: string;
  priceFactor: number;
  maxInputTokens: number;
  canThink: boolean;
  canDisableThinking: boolean;
  efforts: string[];
  defaultEffort: string | null;
  isVision: boolean;
}

function readPriceFactors(): PriceFactor[] {
  try {
    const doc = JSON.parse(fs.readFileSync(PRICE_FACTORS_PATH, 'utf8'));
    if (!doc || !Array.isArray(doc.models)) return [];
    return doc.models
      .filter(
        (item: any) =>
          item &&
          typeof item.displayName === 'string' &&
          item.displayName !== '' &&
          typeof item.priceFactor === 'number' &&
          Number.isFinite(item.priceFactor),
      )
      .map((item: any) => ({
        displayName: item.displayName,
        priceFactor: item.priceFactor,
        maxInputTokens: typeof item.maxInputTokens === 'number' ? item.maxInputTokens : 0,
        canThink: item.canThink === true,
        canDisableThinking: item.canDisableThinking === true,
        efforts: Array.isArray(item.efforts) ? item.efforts.filter((e: any) => typeof e === 'string' && e !== '') : [],
        defaultEffort: typeof item.defaultEffort === 'string' && item.defaultEffort !== '' ? item.defaultEffort : null,
        isVision: item.isVision === true,
      }));
  } catch {
    return [];
  }
}

export function resolveModelName(requested: string, known: string[]): string | undefined {
  if (typeof requested !== 'string' || requested === '') return undefined;
  const lower = requested.toLowerCase();
  return known.find((name) => name.toLowerCase() === lower);
}

export function invalidateModelCache() {
  try {
    fs.rmSync(CACHE_PATH, { force: true });
  } catch {
  }
}
