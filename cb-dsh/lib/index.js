import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { syncProfileModels } from './profile-models.js';
import { blockEnd, indentOf, providerAbove } from './yaml-lines.js';
import { startEventStream } from './events-client.js';
import { closeAll, closeForward, openForward } from './tunnel.js';

export const name = 'cb-dsh';

const CONTROL_HOST = process.env.QB_DSH_CONTROL_HOST || '127.0.0.1';
const CONTROL_PORT = Number(process.env.QB_DSH_CONTROL_PORT || 7802);
const CONTROL_PORT_SPAN = 10;

const CONFIG_DIR = process.env.QB_DSH_CONFIG_DIR
  ? path.resolve(process.env.QB_DSH_CONFIG_DIR)
  : path.join(os.homedir(), '.dsh', 'cb-dsh');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const LOG_PATH = path.join(CONFIG_DIR, 'plugin-host.log');

const DEFAULT_GATEWAY_BASE = (process.env.QB_DSH_GATEWAY || 'http://127.0.0.1:7801').trim();

function log(line) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch {
  }
}

function normalizeBase(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().replace(/\/+$/u, '');
  if (!/^https?:\/\/[^\s/]+/iu.test(value)) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return value;
  } catch {
    return null;
  }
}

function readConfig() {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    stored = {};
  }
  const storedBase = normalizeBase(stored.gatewayBase) || '';
  const base = storedBase || normalizeBase(DEFAULT_GATEWAY_BASE) || 'http://127.0.0.1:7801';
  const apiToken = typeof stored.apiToken === 'string' ? stored.apiToken.trim() : '';
  const configured = Boolean(storedBase && apiToken);
  return { gatewayBase: base, apiToken, storedBase, configured };
}

function writeConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

let activeProfilePath = null;

function resolveProfilePath(ctx) {
  if (process.env.QB_DSH_PROFILE) return path.resolve(process.env.QB_DSH_PROFILE);
  try {
    const profile = ctx && typeof ctx.get === 'function' ? ctx.get('profileContext') : null;
    if (profile && typeof profile.patchPath === 'string' && profile.patchPath !== '') {
      return profile.patchPath;
    }
  } catch {
  }
  return path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
}

function profilePath() {
  return activeProfilePath || resolveProfilePath(null);
}

function readProfileLines() {
  return fs.readFileSync(profilePath(), 'utf8').split(/\r?\n/);
}

function findEntry(lines, id) {
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(\s*)- id:\s*(\S+)\s*$/u.exec(lines[i]);
    if (!match || match[2] !== id) continue;
    const itemIndent = match[1].length;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() === '') continue;
      if (/^\s*-\s+id:/u.test(line) && indentOf(line) === itemIndent) {
        end = j;
        break;
      }
      if (indentOf(line) < itemIndent + 2) {
        end = j;
        break;
      }
    }
    return { start: i, end, itemIndent };
  }
  return null;
}

function readProfileModels(ids) {
  const lines = readProfileLines();
  const wanted = Array.isArray(ids) && ids.length > 0 ? new Set(ids) : null;
  const out = [];
  lines.forEach((line, index) => {
    const match = /^(\s*)- id:\s*(\S+)\s*$/u.exec(line);
    if (!match) return;
    const id = match[2];
    if (wanted && !wanted.has(id)) return;
    const entry = findEntry(lines, id);
    if (!entry || entry.start !== index) return;
    const model = { id, contextWindow: null, maxTokens: null, line: entry.start + 1 };
    for (let j = entry.start + 1; j < entry.end; j += 1) {
      const field = /^\s+(contextWindow|maxTokens):\s*(\d+)\s*$/u.exec(lines[j]);
      if (field) model[field[1]] = Number(field[2]);
    }
    out.push(model);
  });
  return out;
}

function updateProfileModels(updates) {
  const lines = readProfileLines();
  const changed = [];
  for (const update of Array.isArray(updates) ? updates : []) {
    if (!update || typeof update.id !== 'string') continue;
    const entry = findEntry(lines, update.id);
    if (!entry) continue;
    for (const field of ['contextWindow', 'maxTokens']) {
      const value = update[field];
      if (!Number.isInteger(value) || value < 1) continue;
      for (let j = entry.start + 1; j < entry.end; j += 1) {
        const match = new RegExp(`^(\\s+${field}:\\s*)(\\d+)(\\s*)$`, 'u').exec(lines[j]);
        if (!match) continue;
        const from = Number(match[2]);
        if (from === value) break;
        lines[j] = `${match[1]}${value}${match[3]}`;
        changed.push({ id: update.id, field, from, to: value });
        break;
      }
    }
  }
  if (changed.length === 0) return { changed, backup: null };

  const target = profilePath();
  const backup = `${target}.bak-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
  fs.copyFileSync(target, backup);
  fs.writeFileSync(target, lines.join('\n'), 'utf8');
  return { changed, backup: path.basename(backup) };
}

const DEFAULT_CREDENTIAL_REF = 'CB_GATEWAY_API_KEY';

const CREDENTIAL_REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export function inspectProvider() {
  let lines;
  try {
    lines = readProfileLines();
  } catch (error) {
    return { ok: false, error: '读不到 DSH profile：' + error.message };
  }
  const baseAt = lines.findIndex((line) => {
    const match = /^\s*baseURL:\s*(\S+)\s*$/u.exec(line);
    if (!match) return false;
    try {
      return new URL(match[1]).pathname === '/v1';
    } catch {
      return false;
    }
  });
  if (baseAt < 0) return { ok: true, found: false, ref: null, providerId: null };

  const provider = providerAbove(lines, baseAt, indentOf(lines[baseAt]));
  if (!provider) return { ok: true, found: false, ref: null, providerId: null };
  const end = blockEnd(lines, provider.start + 1, provider.indent);
  let ref = null;
  for (let i = provider.start + 1; i < end; i += 1) {
    const match = /^\s*apiKeyEnv:\s*(\S+)\s*$/u.exec(lines[i]);
    if (match && CREDENTIAL_REF_RE.test(match[1])) {
      ref = match[1];
      break;
    }
  }
  return { ok: true, found: true, ref, providerId: provider.key };
}

export function writeProvider(config) {
  const base = normalizeBase(config.gatewayBase);
  if (!base) return { ok: false, error: '网关地址不合法' };
  const ref = typeof config.credentialRef === 'string' ? config.credentialRef.trim() : '';
  if (!ref) return { ok: false, error: '缺凭据引用名' };
  if (!CREDENTIAL_REF_RE.test(ref)) return { ok: false, error: `凭据引用名不合法：${ref}` };

  let lines;
  try {
    lines = readProfileLines();
  } catch (error) {
    return { ok: false, error: '读不到 DSH profile：' + error.message };
  }

  const baseAt = lines.findIndex((line) => {
    const match = /^\s*baseURL:\s*(\S+)\s*$/u.exec(line);
    if (!match) return false;
    try {
      return new URL(match[1]).pathname === '/v1';
    } catch {
      return false;
    }
  });

  let action;
  let providerId;
  let droppedApiKey = false;

  if (baseAt >= 0) {
    lines[baseAt] = lines[baseAt].replace(/(baseURL:\s*)\S+/u, '$1' + base + '/v1');
    const provider = providerAbove(lines, baseAt, indentOf(lines[baseAt]));
    const providerEnd = provider ? blockEnd(lines, provider.start + 1, provider.indent) : lines.length;
    const providerStart = provider ? provider.start : 0;

    let envAt = -1;
    let apiKeyAt = -1;
    for (let i = providerStart + 1; i < providerEnd; i += 1) {
      if (envAt < 0 && /^\s*apiKeyEnv:\s*/u.test(lines[i])) envAt = i;
      if (apiKeyAt < 0 && /^\s*apiKey:\s*.*$/u.test(lines[i])) apiKeyAt = i;
    }
    const fieldIndent = ' '.repeat(indentOf(lines[baseAt]));
    if (envAt >= 0) {
      lines[envAt] = lines[envAt].replace(/(apiKeyEnv:\s*).*$/u, '$1' + ref);
    } else {
      lines.splice(baseAt + 1, 0, fieldIndent + 'apiKeyEnv: ' + ref);
      if (apiKeyAt >= 0 && apiKeyAt > baseAt) apiKeyAt += 1;
    }
    if (apiKeyAt >= 0) {
      lines.splice(apiKeyAt, 1);
      droppedApiKey = true;
    }
    action = 'updated';
    providerId = provider ? provider.key : '?';
  } else {
    const pluginAt = lines.findIndex((line) => /^- id:\s*llm-pi-ai\s*$/u.test(line));
    if (pluginAt < 0) {
      return {
        ok: false,
        error: 'profile 里没有 llm-pi-ai 条目（DSH 没启用 OpenAI 兼容 provider？），没法写 provider',
      };
    }

    let entryEnd = lines.length;
    for (let i = pluginAt + 1; i < lines.length; i += 1) {
      if (/^- id:/u.test(lines[i])) {
        entryEnd = i;
        break;
      }
    }

    const pad = (n) => ' '.repeat(n);
    const entryIndent = indentOf(lines[pluginAt]);
    const keyIndent = entryIndent + 2;
    const providersKeyIndent = keyIndent + 2;
    const providerIndent = providersKeyIndent + 2;
    const fieldIndent = providerIndent + 2;

    const providerLines = [
      pad(providerIndent) + 'qb:',
      pad(fieldIndent) + 'displayName: 积分桥',
      pad(fieldIndent) + 'api: openai-completions',
      pad(fieldIndent) + 'baseURL: ' + base + '/v1',
      pad(fieldIndent) + 'apiKeyEnv: ' + ref,
      pad(fieldIndent) + 'models: []',
    ];

    let providersAt = -1;
    let providersInlineEmpty = false;
    for (let i = pluginAt + 1; i < entryEnd; i += 1) {
      if (/^\s*providers:\s*$/u.test(lines[i])) {
        providersAt = i;
        break;
      }
      if (/^\s*providers:\s*\{\s*\}\s*$/u.test(lines[i])) {
        providersAt = i;
        providersInlineEmpty = true;
        break;
      }
    }

    if (providersAt >= 0 && providersInlineEmpty) {
      lines.splice(providersAt, 1, pad(providersKeyIndent) + 'providers:', ...providerLines);
    } else if (providersAt >= 0) {
      const providersIndent = indentOf(lines[providersAt]);
      let insertAt = providersAt + 1;
      for (let i = providersAt + 1; i < entryEnd; i += 1) {
        if (lines[i].trim() === '') break;
        if (indentOf(lines[i]) <= providersIndent) break;
        insertAt = i + 1;
      }
      lines.splice(insertAt, 0, ...providerLines);
    } else {
      let configAt = -1;
      for (let i = pluginAt + 1; i < entryEnd; i += 1) {
        if (/^\s*config:\s*$/u.test(lines[i])) {
          configAt = i;
          break;
        }
      }
      if (configAt >= 0) {
        let insertAt = configAt + 1;
        for (let i = configAt + 1; i < entryEnd; i += 1) {
          if (lines[i].trim() === '') break;
          if (indentOf(lines[i]) <= keyIndent) break;
          insertAt = i + 1;
        }
        lines.splice(insertAt, 0, pad(providersKeyIndent) + 'providers:', ...providerLines);
      } else {
        lines.splice(entryEnd, 0, pad(keyIndent) + 'config:', pad(providersKeyIndent) + 'providers:', ...providerLines);
      }
    }

    action = 'created';
    providerId = 'qb';
  }

  const target = profilePath();
  const backup = target + '.bak-provider-' + new Date().toISOString().replace(/[:.]/gu, '-');
  try {
    fs.copyFileSync(target, backup);
    fs.writeFileSync(target, lines.join('\n'), 'utf8');
  } catch (error) {
    return { ok: false, error: '写 profile 失败：' + error.message };
  }
  log(
    '写 provider：' + action + ' ' + providerId + ' → ' + base + '/v1，凭据引用 ' + ref +
      (droppedApiKey ? '（删掉了明文 apiKey 行）' : '') +
      '（备份 ' + path.basename(backup) + '）',
  );
  return { ok: true, action, providerId, ref, droppedApiKey, backup: path.basename(backup) };
}

const MODEL_SYNC_INTERVAL_MS = 15 * 1000;
const MODEL_SYNC_START_DELAY_MS = 4 * 1000;

let modelSyncState = { at: null, ok: null, error: null, models: 0, wrote: false, backup: null, trigger: null };
let modelSyncTask = null;
let lastSyncError = '';

function gatewayAuthHeader(config) {
  return config.apiToken ? `Bearer ${config.apiToken}` : '';
}

function runModelSync(trigger) {
  if (modelSyncTask) return modelSyncTask;
  const task = (async () => {
    try {
      const config = readConfig();
      if (!config.configured) {
        const message = '还没配置网关地址和 API key';
        modelSyncState = { at: Date.now(), ok: false, configured: false, error: message, models: 0, wrote: false, backup: null, trigger };
        if (message !== lastSyncError) {
          log(`模型同步（${trigger}）跳过：${message}`);
          lastSyncError = message;
        }
        return { ok: false, configured: false, error: message };
      }
      const result = await syncProfileModels({
        profilePath: profilePath(),
        base: config.gatewayBase,
        auth: gatewayAuthHeader(config),
        log,
      });
      modelSyncState = { at: Date.now(), ok: true, configured: true, error: null, trigger, ...result };
      if (result.wrote) {
        log(`模型同步（${trigger}）：写入 ${result.models} 个模型（备份 ${result.backup ? path.basename(result.backup) : '—'}）`);
      }
      lastSyncError = '';
      return { ok: true, ...result };
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      modelSyncState = { at: Date.now(), ok: false, error: message, models: 0, wrote: false, backup: null, trigger };
      if (message !== lastSyncError) {
        log(`模型同步（${trigger}）失败：${message}`);
        lastSyncError = message;
      }
      return { ok: false, error: message };
    }
  })();

  modelSyncTask = task;
  const clear = () => {
    if (modelSyncTask === task) modelSyncTask = null;
  };
  task.then(clear, clear);
  return task;
}

function hostAllowed(host) {
  if (typeof host !== 'string' || host === '') return true;
  return /^(localhost|\[[0-9a-f:.]+\]|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/iu.test(host);
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 8 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

function createControlServer() {
  return http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1');
    try {
      if (!hostAllowed(req.headers.host)) {
        sendJson(res, 403, { ok: false, error: `host not allowed: ${req.headers.host}` });
        return;
      }

      if (url.pathname === '/diag' && req.method === 'POST') {
        const raw = await readBody(req);
        log(`diag ${String(raw).slice(0, 800)}`);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (url.pathname === '/config' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, ...readConfig(), default: normalizeBase(DEFAULT_GATEWAY_BASE) });
        return;
      }

      if (url.pathname === '/config' && req.method === 'POST') {
        const raw = await readBody(req);
        let body = {};
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          sendJson(res, 400, { ok: false, error: '请求体不是 JSON' });
          return;
        }
        const current = readConfig();
        const base = body && body.gatewayBase !== undefined ? normalizeBase(body.gatewayBase) : current.gatewayBase;
        if (!base) {
          sendJson(res, 400, { ok: false, error: '网关地址要写成 http://主机:端口' });
          return;
        }
        const apiToken = body && body.apiToken !== undefined ? String(body.apiToken || '').trim() : current.apiToken;
        writeConfig({ gatewayBase: base, apiToken });
        log(`config -> ${base}${apiToken ? '（有 key）' : '（没有 key）'}`);
        startEvents();
        sendJson(res, 200, { ok: true, gatewayBase: base, apiToken, configured: Boolean(base && apiToken) });
        return;
      }

      if (url.pathname === '/setup' && req.method === 'POST') {
        const raw = await readBody(req);
        let body = {};
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          sendJson(res, 400, { ok: false, error: '请求体不是 JSON' });
          return;
        }
        const base = body && body.gatewayBase !== undefined ? normalizeBase(body.gatewayBase) : readConfig().gatewayBase;
        if (!base) {
          sendJson(res, 400, { ok: false, error: '网关地址要写成 http://主机:端口' });
          return;
        }
        const apiToken = body && body.apiToken !== undefined ? String(body.apiToken || '').trim() : readConfig().apiToken;
        if (!apiToken) {
          sendJson(res, 400, { ok: false, error: '先填 API key（在网关 /keys 页创建）' });
          return;
        }

        const target = inspectProvider();
        if (target.ok === false) {
          sendJson(res, 500, { ok: false, gatewayBase: base, error: target.error });
          return;
        }
        const ref = target.ref || DEFAULT_CREDENTIAL_REF;

        const credentials = getCredentials();
        if (!credentials) {
          sendJson(res, 500, {
            ok: false,
            gatewayBase: base,
            error:
              '这个 DSH 没有可用的 credentials 服务，key 没地方存。' +
              '先在 DSH 设置 → 模型服务里给这个 provider 填一次 key，再回来改地址',
          });
          return;
        }
        try {
          await credentials.set(ref, apiToken);
        } catch (error) {
          sendJson(res, 500, {
            ok: false,
            gatewayBase: base,
            error: `写不进凭据库（${ref}）：${error && error.message ? error.message : error}`,
          });
          return;
        }

        const provider = writeProvider({ gatewayBase: base, credentialRef: ref });
        if (!provider.ok) {
          sendJson(res, 500, { ok: false, gatewayBase: base, error: provider.error });
          return;
        }

        writeConfig({ gatewayBase: base, apiToken });
        startEvents();

        const sync = await runModelSync('setup');
        sendJson(res, 200, {
          ok: true,
          gatewayBase: base,
          configured: Boolean(base && apiToken),
          credentialRef: ref,
          provider,
          sync,
        });
        return;
      }

      if (url.pathname === '/model-config' && req.method === 'GET') {
        const ids = (url.searchParams.get('ids') || '')
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean);
        try {
          sendJson(res, 200, { ok: true, profile: profilePath(), models: readProfileModels(ids) });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error.message });
        }
        return;
      }

      if (url.pathname === '/model-config' && req.method === 'POST') {
        const raw = await readBody(req);
        let body = {};
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          sendJson(res, 400, { ok: false, error: '请求体不是 JSON' });
          return;
        }
        try {
          const result = updateProfileModels(body && body.updates);
          if (result.changed.length > 0) {
            log(`model-config: ${result.changed.length} 个字段已改（备份 ${result.backup}）`);
          }
          sendJson(res, 200, { ok: true, changed: result.changed, backup: result.backup });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error.message });
        }
        return;
      }

      if (url.pathname === '/model-sync' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, state: modelSyncState });
        return;
      }

      if (url.pathname === '/model-sync' && req.method === 'POST') {
        const result = await runModelSync('manual');
        sendJson(res, result.ok === false ? 500 : 200, { ok: result.ok !== false, ...result });
        return;
      }

      sendJson(res, 404, { ok: false, error: 'no route' });
    } catch (error) {
      log(`control error ${req.method} ${url.pathname}: ${error.message}`);
      sendJson(res, 500, { ok: false, error: error.message });
    }
  });
}

const SERVER_KEY = Symbol.for('dsh.quota.bridge.controlServer');
const EVENTS_KEY = Symbol.for('dsh.quota.bridge.eventStream');

let credentialsService = null;
let hostCtx = null;

function getCredentials() {
  if (credentialsService) return credentialsService;
  try {
    const live = hostCtx && typeof hostCtx.get === 'function' ? hostCtx.get('credentials') : null;
    if (live) credentialsService = live;
  } catch {
  }
  return credentialsService;
}

function captureCredentials(ctx) {
  hostCtx = ctx || null;
  try {
    if (ctx && typeof ctx.inject === 'function') {
      ctx.inject(['credentials'], (scope) => {
        const found =
          (scope && typeof scope.get === 'function' ? scope.get('credentials') : null) ||
          (scope && scope.credentials) ||
          null;
        if (found) {
          credentialsService = found;
          log('credentials 服务已就绪（面板可以把 key 存进凭据库）');
        } else {
          log('inject 到 credentials 但取不到实例');
        }
      });
    }
  } catch (error) {
    log('inject credentials 失败：' + (error && error.message ? error.message : error));
  }
}

export function apply(ctx) {
  try {
    applyInner(ctx);
  } catch (error) {
    log(`apply failed: ${error && error.stack ? error.stack : error}`);
  }
}

function handleGatewayEvent(event) {
  if (!event || event.type !== 'login') return;
  const loopback = event.loopback;
  if (!loopback || !loopback.port) return;

  if (event.state === 'running') {
    const config = readConfig();
    let target;
    try {
      target = new URL(config.gatewayBase);
    } catch {
      log(`登录通道没法开：网关地址不合法（${config.gatewayBase}）`);
      return;
    }
    if (target.protocol !== 'http:') {
      log(`登录通道没法开：网关是 ${target.protocol}，而回调是明文 HTTP（纯 TCP 转发不支持）`);
      return;
    }
    openForward({ port: loopback.port, targetHost: target.hostname, targetPort: loopback.port }).then((result) => {
      if (result.ok) {
        log(`${event.channelId} 登录：已把 127.0.0.1:${loopback.port} 转到 ${target.hostname}:${loopback.port}`);
      } else {
        log(`${event.channelId} 登录：开回调通道失败 —— ${result.error}`);
      }
    });
    return;
  }

  if (closeForward(loopback.port)) {
    log(`${event.channelId} 登录结束（${event.state}）：回调通道已关闭`);
  }
}

function startEvents() {
  const previous = globalThis[EVENTS_KEY];
  if (previous && typeof previous.stop === 'function') {
    try {
      previous.stop();
      log('previous event stream stopped (reload)');
    } catch {
    }
  }
  const config = readConfig();
  if (!config.configured) {
    log('还没配置网关地址和 API key，事件流不启动（登录通道不会自动开）');
    globalThis[EVENTS_KEY] = null;
    return null;
  }
  const stream = startEventStream({
    baseUrl: config.gatewayBase,
    apiToken: config.apiToken,
    onEvent: handleGatewayEvent,
    log,
  });
  globalThis[EVENTS_KEY] = stream;
  return stream;
}

function listenControl(server) {
  let port = CONTROL_PORT;
  const last = CONTROL_PORT + CONTROL_PORT_SPAN - 1;

  const attempt = () => {
    const onError = (error) => {
      if (error && error.code === 'EADDRINUSE' && port < last) {
        port += 1;
        attempt();
        return;
      }
      log(`control server 绑不上 ${CONTROL_HOST}:${port}：${error && error.message ? error.message : error}`);
    };
    server.once('error', onError);
    server.listen(port, CONTROL_HOST, () => {
      server.removeListener('error', onError);
      const shown = CONTROL_HOST === '0.0.0.0' ? '0.0.0.0（局域网可达）' : CONTROL_HOST;
      log(`control server listening on http://${shown}:${port}`);
    });
  };

  attempt();
}

function applyInner(ctx) {
  activeProfilePath = resolveProfilePath(ctx);
  log(
    `host-apply (control ${CONTROL_HOST}:${CONTROL_PORT}(起), gateway ${readConfig().gatewayBase}, profile ${activeProfilePath})`,
  );
  captureCredentials(ctx);

  const previous = globalThis[SERVER_KEY];
  if (previous && typeof previous.close === 'function') {
    try {
      previous.close();
      log('previous control server closed (reload)');
    } catch {
    }
  }

  const server = createControlServer();
  server.on('error', (error) => log(`control server error: ${error.message}`));
  listenControl(server);
  globalThis[SERVER_KEY] = server;

  startEvents();

  const syncTimer = setInterval(() => {
    runModelSync('poll');
  }, MODEL_SYNC_INTERVAL_MS);
  syncTimer.unref?.();
  const syncKickoff = setTimeout(() => {
    runModelSync('startup');
  }, MODEL_SYNC_START_DELAY_MS);
  syncKickoff.unref?.();

  if (ctx && typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      try {
        clearInterval(syncTimer);
        clearTimeout(syncKickoff);
        const stream = globalThis[EVENTS_KEY];
        if (stream && typeof stream.stop === 'function') stream.stop();
        globalThis[EVENTS_KEY] = null;
        closeAll();
        server.close();
        log('control server closed (dispose)');
      } catch {
      }
    });
  }
}
