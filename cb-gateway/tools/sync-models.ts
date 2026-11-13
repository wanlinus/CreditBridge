import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PROFILE_PATH, locateModels, parseModels, readProfileLines, writeProfileLines } from '../src/shared/profile-yaml.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(GATEWAY_DIR, 'data');
const PROFILE = PROFILE_PATH;
const WRITE = process.argv.includes('--write');
const CHANNEL_PREFIX = '/workbuddy';

const DSH_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const UPSTREAM_TO_DSH = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' };

function readJson(file: any) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function loadCatalog() {
  const cached = path.join(DATA_DIR, 'state', 'workbuddy-catalog.json');
  if (fs.existsSync(cached)) {
    const age = Date.now() - fs.statSync(cached).mtimeMs;
    if (age < 60 * 60 * 1000) return readJson(cached).data.models;
  }
  const auth = readJson(path.join(DATA_DIR, 'auth', 'workbuddy.json'));
  const response = await fetch('https://copilot.tencent.com/v3/config', {
    headers: {
      authorization: `Bearer ${auth.accessToken}`,
      accept: 'application/json',
      'user-agent': 'WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0',
      origin: 'https://www.codebuddy.cn',
      referer: 'https://www.codebuddy.cn/',
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`catalog http ${response.status}`);
  const doc: any = await response.json();
  fs.writeFileSync(cached, JSON.stringify(doc, null, 2));
  return doc.data.models;
}

function effortsFor(model: any) {
  if (!model.supportsReasoning) return false;
  const reasoning = model.reasoning || {};
  let levels = Array.isArray(reasoning.supportedEfforts) ? reasoning.supportedEfforts.slice() : null;

  if (!levels) levels = ['low', 'medium', 'high', 'xhigh'];

  const efforts: any = {};
  if (reasoning.canDisableThinking === true) efforts.off = null;

  for (const level of levels) {
    const dsh = (UPSTREAM_TO_DSH as any)[level];
    if (!dsh) continue;
    if (dsh === 'xhigh' && efforts.xhigh && level !== 'max') continue;
    efforts[dsh] = level;
  }
  if (Object.keys(efforts).every((k) => k === 'off')) return false;
  const ordered: any = {};
  for (const level of DSH_LEVELS) if (level in efforts) ordered[level] = efforts[level];
  return ordered;
}

function yamlEfforts(efforts: any, pad: any) {
  const lines = [pad + 'reasoningEfforts:'];
  for (const [level, wire] of Object.entries(efforts)) {
    lines.push(pad + '  ' + level + ':' + (wire === null ? '' : ' ' + wire));
  }
  return lines;
}

function buildBlock(models: any, catalogById: any, range: any) {
  const pad = (n: any) => ' '.repeat(n);
  const modelsPad = pad(range.itemIndent - 2);
  const itemPad = pad(range.itemIndent);
  const fieldPad = pad(range.fieldIndent);
  const lines = [`${modelsPad}models:`];
  const warnings = [];
  for (const model of models) {
    const live = catalogById.get(model.id);
    if (!live) {
      warnings.push(`  ${model.id}: not in upstream catalog (kept as-is)`);
      lines.push(`${itemPad}- id: ${model.id}`);
      if (model.name) lines.push(`${fieldPad}name: ${JSON.stringify(model.name)}`);
      if (model.contextWindow) lines.push(`${fieldPad}contextWindow: ${model.contextWindow}`);
      if (model.maxTokens) lines.push(`${fieldPad}maxTokens: ${model.maxTokens}`);
      continue;
    }
    const ctx = live.maxInputTokens;
    const out = live.maxOutputTokens;
    lines.push(`${itemPad}- id: ${model.id}`);
    if (model.name) lines.push(`${fieldPad}name: ${JSON.stringify(model.name)}`);
    lines.push(`${fieldPad}contextWindow: ${ctx}`);
    lines.push(`${fieldPad}maxTokens: ${out}`);
    const modalities = ['text'];
    if (live.supportsImages) modalities.push('image');
    lines.push(`${fieldPad}input:`);
    for (const m of modalities) lines.push(`${fieldPad}  - ${m}`);
    if (model.input && model.input.join(',') !== modalities.join(',')) {
      warnings.push(`  ${model.id}: input ${model.input.join('+')} -> ${modalities.join('+')}`);
    }
    if (model.contextWindow !== ctx || model.maxTokens !== out) {
      warnings.push(`  ${model.id}: ctx ${model.contextWindow} -> ${ctx}, max ${model.maxTokens} -> ${out}`);
    }
    if (!model.reasoningEfforts && !model.input) {
      warnings.push(`  ${model.id}: gained reasoningEfforts and input`);
    }
    const efforts = effortsFor(live);
    if (efforts === false) {
      lines.push(`${fieldPad}reasoningEfforts: false`);
    } else {
      lines.push(...yamlEfforts(efforts, fieldPad));
    }
  }
  return { lines, warnings };
}

const yamlPath = path.join(process.env.USERPROFILE || '', '.dsh', 'profiles', 'node_modules', 'js-yaml', 'index.js');
const yaml = (await import(pathToFileURL(yamlPath).href)).default;
const lines = readProfileLines();
const range = locateModels(lines, CHANNEL_PREFIX);
const doc = yaml.load(fs.readFileSync(PROFILE, 'utf8'));
const entry = doc.find((e: any) => e.id === 'llm-pi-ai');
if (!entry) throw new Error('llm-pi-ai entry not found in profile');
const configured = entry.config.providers[range.provider]?.models;
if (!Array.isArray(configured)) throw new Error(`provider ${range.provider} 没有 models 列表`);

const catalog = await loadCatalog();
const catalogById = new Map(catalog.map((m: any) => [m.id, m]));

const { lines: block, warnings } = buildBlock(configured, catalogById, range);

console.log(`provider: ${range.provider}  models: ${configured.length}  upstream: ${catalog.length}`);
if (warnings.length) {
  console.log('\nchanges:');
  for (const w of warnings) console.log(w);
} else {
  console.log('\nno differences');
}
console.log('\n--- generated block ---');
console.log(block.join('\n'));

if (!WRITE) {
  console.log('\n(dry run; pass --write to apply)');
  process.exit(0);
}

const next = [...lines.slice(0, range.listStart), ...block, ...lines.slice(range.listEnd)];
const backup = writeProfileLines(next);
console.log('\nwritten. backup: ' + backup);

const after = readProfileLines();
const reloaded = parseModels(after, locateModels(after, CHANNEL_PREFIX));
if (reloaded.length !== configured.length) {
  throw new Error(`re-parse found ${reloaded.length} models, expected ${configured.length} — 缩进可能写坏了`);
}
console.log('re-parse ok, models: ' + reloaded.length);
