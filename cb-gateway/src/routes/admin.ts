import fs from 'node:fs';
import path from 'node:path';

import { Hono } from 'hono';

import type { AppEnv } from '../app.ts';
import { log } from '../logger.ts';
import { config } from '../config.ts';
import { LOG_DIR } from '../shared/paths.ts';
import { channels, channelByPrefix, channelById } from '../channels/index.ts';
import { accountsOf, getAccount } from '../core/accounts.ts';
import { iconOf, letterOf } from '../core/channel-icons.ts';
import { externalModelId, parseModelId } from '../core/router.ts';
import { listModelCooldowns } from '../core/model-cooldown.ts';
import { readCheckinLog } from '../core/checkin-log.ts';
import { modelListPayload } from './openai.ts';
import { usageSummary } from '../ledger.ts';
import { readModelConfig, writeModelConfig, PROFILE_PATH } from '../shared/model-config.ts';
import { PACKAGE_VERSION as BUILD_VERSION, STARTED_AT_ISO } from '../shared/build-info.ts';
import { isListed, setListed, setVisibleFor, visibleFor, visibleModels } from '../shared/model-visibility.ts';
import { requestShutdown } from '../lifecycle.ts';
import { subscribeEvents, subscriberCount, type GatewayEvent } from '../core/events.ts';

const PACKAGE_VERSION = BUILD_VERSION;
const STARTED_AT = STARTED_AT_ISO;

export const adminRoutes = new Hono<AppEnv>();

adminRoutes.get('/api/health', (c) => {
  const accounts = channels.flatMap((channel) =>
    accountsOf(channel.id).map((account) => ({
      id: account.id,
      channelId: channel.id,
      channelLabel: channel.label,
      idPrefix: channel.idPrefix,
      label: account.label,
      status: account.status,
      statusMessage: account.statusMessage,
      cooldownUntil: account.cooldownUntil,
      uid: account.profile?.uid ?? null,
      username: account.profile?.username ?? null,
      hasCredential: Boolean(account.credential),
      createdAt: account.createdAt,
    })),
  );

  const info: Record<string, any> = {};
  for (const channel of channels) {
    info[channel.id] = {
      id: channel.id,
      label: channel.label,
      idPrefix: channel.idPrefix,
      identity: channel.identity,
      listed: isListed(channel.idPrefix),
      multiAccount: channel.multiAccount !== false,
      canLogin: typeof channel.login === 'function',
      canLogout: typeof channel.logoutOf === 'function',
      canRotateDevice: typeof channel.rotateDeviceIdOf === 'function',
      canVerify: typeof channel.probe === 'function',
      accounts: accounts.filter((account) => account.channelId === channel.id).map((account) => account.id),
    };
  }

  return c.json({
    ok: true,
    gateway: 'up',
    version: PACKAGE_VERSION,
    startedAt: STARTED_AT,
    checkinTime: config.checkinTime,
    modelIdFormat: '<idPrefix>-<seq>/<model>',
    channels: info,
    accounts,
  });
});

adminRoutes.get('/api/channels', (c) => {
  c.header('Cache-Control', 'private, max-age=300');
  return c.json({
    channels: channels.map((channel) => ({
      id: channel.id,
      label: channel.label,
      idPrefix: channel.idPrefix,
      letter: letterOf(channel),
      icon: iconOf(channel.id),
    })),
  });
});

adminRoutes.get('/api/models', async (c) => {
  return c.json(await modelListPayload());
});

adminRoutes.get('/api/models/catalog', async (c) => {
  const accountId = new URL(c.req.url).searchParams.get('account');

  if (accountId) {
    const account = getAccount(accountId);
    const channel = account ? channelById(account.channelId) : undefined;
    if (!account || !channel) {
      return c.json({ error: { message: `没有账号 ${accountId}`, type: 'not_found' } }, 404);
    }
    let models: any[] = [];
    let error: string | null = null;
    try {
      models = await channel.modelsOf(account);
    } catch (err: any) {
      error = err?.message || String(err);
    }
    return c.json({
      account: account.id,
      channelId: channel.id,
      idPrefix: channel.idPrefix,
      label: channel.label,
      models,
      error,
      visible: visibleFor(channel.idPrefix),
      listed: isListed(channel.idPrefix),
    });
  }

  const groups = [];
  for (const channel of channels) {
    const accounts = accountsOf(channel.id);
    const source = accounts.find((account) => account.status === 'ready') ?? accounts[0] ?? null;
    let models: any[] = [];
    let error: string | null = null;
    if (source) {
      try {
        models = await channel.modelsOf(source);
      } catch (err: any) {
        error = err?.message || String(err);
      }
    }
    groups.push({
      channelId: channel.id,
      idPrefix: channel.idPrefix,
      label: channel.label,
      source: source ? source.id : null,
      models,
      error,
      visible: visibleFor(channel.idPrefix),
      listed: isListed(channel.idPrefix),
      multiAccount: channel.multiAccount !== false,
    });
  }
  return c.json({ channels: groups });
});

adminRoutes.get('/api/models/cooldowns', (c) => {
  const only = new URL(c.req.url).searchParams.get('account');
  const targetAccounts = only
    ? channels.flatMap((channel) => accountsOf(channel.id).filter((account) => account.id === only))
    : channels.flatMap((channel) => accountsOf(channel.id));

  if (only && targetAccounts.length === 0) {
    return c.json({ error: { message: `没有账号 ${only}`, type: 'not_found' } }, 404);
  }

  const entries = [];
  for (const account of targetAccounts) {
    for (const cooldown of listModelCooldowns(account.id)) {
      entries.push({
        account: account.id,
        channelId: account.channelId,
        model: cooldown.model,
        until: cooldown.until,
        message: cooldown.message ?? null,
      });
    }
  }
  return c.json({ cooldowns: entries });
});

adminRoutes.on(['GET', 'POST'], '/api/model-config', async (c) => {
  const catalogChannels = channels.filter((channel) => typeof channel.catalogOf === 'function');

  if (c.req.method === 'GET') {
    const only = (new URL(c.req.url).searchParams.get('ids') || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    const keep = only.length > 0 ? new Set(only) : null;

    const wantedPrefixes = new Set<string>();
    if (keep) {
      for (const id of keep) {
        const parsed = parseModelId(id);
        if (parsed) wantedPrefixes.add(parsed.prefix);
      }
    }
    const targets = catalogChannels.filter(
      (channel) => !keep || wantedPrefixes.size === 0 || wantedPrefixes.has(channel.idPrefix),
    );

    const upstream: Record<string, any> = {};
    for (const channel of targets) {
      for (const account of accountsOf(channel.id)) {
        try {
          for (const model of await channel.catalogOf!(account)) {
            const externalId = externalModelId(account, model.id);
            if (keep && !keep.has(externalId)) continue;
            upstream[externalId] = { ...model, id: externalId, upstreamId: model.id, account: account.id };
          }
        } catch (error: any) {
          log(`model-config: catalog unavailable for ${channel.id}/${account.id} (${error.message})`);
        }
      }
    }

    let models: any[] = [];
    try {
      for (const channel of targets.length > 0 ? targets : catalogChannels) {
        models = models.concat(readModelConfig(channel.idPrefix).filter((model) => !keep || keep.has(model.id)));
      }
    } catch (error: any) {
      log(`model-config: profile block unavailable (${error.message})`);
    }
    return c.json({
      ok: true,
      profile: PROFILE_PATH,
      provider: catalogChannels.length > 0 ? catalogChannels[0].id : null,
      models,
      upstream,
    });
  }

  let body: any;
  try {
    body = JSON.parse(await c.req.text());
  } catch (error: any) {
    return c.json({ error: { message: `请求体不是合法 JSON：${error.message}`, type: 'bad_request' } }, 400);
  }
  const updates = Array.isArray(body && body.updates) ? body.updates : [];
  if (catalogChannels.length === 0) {
    return c.json({ error: { message: '没有通道提供上游模型目录，无法编辑上下文窗口', type: 'bad_request' } }, 400);
  }

  const byPrefix = new Map<string, any[]>();
  for (const update of updates) {
    const parsed = parseModelId(update && update.id);
    const prefix = parsed ? parsed.prefix : catalogChannels[0].idPrefix;
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix)!.push(update);
  }

  const changed: any[] = [];
  const backups: string[] = [];
  for (const [prefix, items] of byPrefix) {
    try {
      const result = writeModelConfig(prefix, items);
      changed.push(...result.changed);
      if (result.backup) backups.push(result.backup);
    } catch (error: any) {
      return c.json({ error: { message: `${prefix}: ${error.message}`, type: 'bad_request' } }, 400);
    }
  }
  const backup = backups.length > 0 ? backups[backups.length - 1] : null;
  log(`model-config: ${changed.length} field(s) updated${backup ? ', backup ' + backup : ''}`);
  return c.json({ ok: true, changed, backup });
});

adminRoutes.get('/api/models/visibility', (c) => {
  const visible = visibleModels();
  const out: Record<string, { listed: boolean; models: string[] | null }> = {};
  for (const channel of channels) {
    out[channel.idPrefix] = {
      listed: isListed(channel.idPrefix),
      models: visible[channel.idPrefix] ?? null,
    };
  }
  return c.json({ channels: out });
});

adminRoutes.post('/api/models/visibility', async (c) => {
  let body: any;
  try {
    body = JSON.parse((await c.req.text()) || '{}');
  } catch (error: any) {
    return c.json({ error: { message: `请求体不是合法 JSON：${error.message}`, type: 'bad_request' } }, 400);
  }
  const channel = channelByPrefix(typeof body?.prefix === 'string' ? body.prefix : '');
  if (!channel) return c.json({ error: { message: `没有前缀 ${body?.prefix}`, type: 'not_found' } }, 404);

  if (body?.action === 'toggle-list') {
    const listed = body.listed === true;
    setListed(channel.idPrefix, listed);
    log(`模型列表: ${channel.idPrefix} ${listed ? '打开' : '关闭'}`);
    return c.json({ ok: true, prefix: channel.idPrefix, listed });
  }
  if (body?.action === 'all') {
    setListed(channel.idPrefix, true);
    setVisibleFor(channel.idPrefix, null);
    log(`模型可见性: ${channel.idPrefix} 恢复全部显示`);
    return c.json({ ok: true, prefix: channel.idPrefix, listed: true, visible: null });
  }
  if (!Array.isArray(body?.visible)) {
    return c.json({ error: { message: '需要一个 action，或 visible 数组', type: 'bad_request' } }, 400);
  }
  const ids = body.visible.filter((id: unknown) => typeof id === 'string' && id !== '');
  setVisibleFor(channel.idPrefix, ids);
  log(`模型可见性: ${channel.idPrefix} 只显示 ${ids.length} 个模型`);
  return c.json({ ok: true, prefix: channel.idPrefix, visible: ids });
});

adminRoutes.get('/api/usage', async (c) => {
  const account = new URL(c.req.url).searchParams.get('account');
  return c.json(await usageSummary({ account: account || null }));
});

adminRoutes.get('/api/checkin/log', (c) => {
  const accountNames: Record<string, string> = {};
  for (const channel of channels) {
    for (const account of accountsOf(channel.id)) {
      accountNames[account.id] = `${channel.label} / ${account.label}`;
    }
  }
  return c.json({ entries: readCheckinLog(), accountNames });
});

adminRoutes.get('/api/plugin-probe', (c) => {
  const stage = new URL(c.req.url).searchParams.get('stage') || '?';
  try {
    fs.appendFileSync(path.join(LOG_DIR, 'plugin-probe.log'), `${new Date().toISOString()} ${stage}\n`);
  } catch {
  }
  return c.json({ ok: true, stage });
});

const EVENTS_KEEPALIVE_MS = 30_000;

adminRoutes.get('/api/events', (c) => {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  function cleanup() {
    if (closed) return;
    closed = true;
    if (keepalive) clearInterval(keepalive);
    keepalive = null;
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    log(`SSE 订阅断开（剩余 ${subscriberCount()} 个）`);
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      unsubscribe = subscribeEvents((event: GatewayEvent) => {
        send(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      });
      send(`: connected ${new Date().toISOString()}\n\n`);
      log(`SSE 订阅接入（当前 ${subscriberCount()} 个）`);
      keepalive = setInterval(() => send(': keepalive\n\n'), EVENTS_KEEPALIVE_MS);
      keepalive.unref?.();
    },
    cancel() {
      cleanup();
    },
  });

  return c.newResponse(stream as any, 200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
});

adminRoutes.post('/api/shutdown', (c) => {
  requestShutdown();
  return c.json({ ok: true, stopping: true });
});
