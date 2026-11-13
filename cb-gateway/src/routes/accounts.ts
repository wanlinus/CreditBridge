import { Hono } from 'hono';

import type { AppEnv } from '../app.ts';
import type { Account } from '../types.ts';
import { channelById, channels } from '../channels/index.ts';
import { accountsOf, getAccount, listAccounts, markInvalid, markReady, removeAccount, setStatus, updateAccount } from '../core/accounts.ts';
import { accountsWithSpend, buildCredits } from '../core/credits.ts';
import { buildBadge } from '../core/badge.ts';
import { appendCheckinLog } from '../core/checkin-log.ts';
import { answerLoginPrompt, getLoginTask, publicTask, startLogin } from '../core/login-tasks.ts';
import { usageSummary } from '../ledger.ts';
import { log } from '../logger.ts';
import { isCredentialError } from '../shared/credential-error.ts';

export const accountsRoutes = new Hono<AppEnv>();

const CHANNEL_IDS = channels.map((channel) => channel.id);

function accountWithChannel(id: string): { account: Account; channel: NonNullable<ReturnType<typeof channelById>> } | null {
  const account = getAccount(id);
  const channel = account ? channelById(account.channelId) : undefined;
  return account && channel ? { account, channel } : null;
}

accountsRoutes.get('/api/accounts', async (c) => {
  const accounts = listAccounts(CHANNEL_IDS);
  const { credits, tokensToday, tokensTotal } = await accountsWithSpend(accounts);
  return c.json({
    accounts: accounts.map((account) => {
      const snapshot = credits[account.id];
      return {
        id: account.id,
        channelId: account.channelId,
        channelLabel: channelById(account.channelId)?.label || account.channelId,
        idPrefix: channelById(account.channelId)?.idPrefix || '',
        seq: account.seq,
        label: account.label,
        status: account.status,
        statusMessage: account.statusMessage,
        cooldownUntil: account.cooldownUntil,
        profile: account.profile,
        createdAt: account.createdAt,
        totalRemain: snapshot?.remain ?? null,
        usedTotal: snapshot?.used ?? null,
        limitTotal: snapshot?.limit ?? null,
        prevRemain: snapshot?.prevRemain ?? null,
        prevAt: snapshot?.prevAt ?? null,
        creditsAt: snapshot?.at ?? null,
        todayTokens: tokensToday[account.id] ?? 0,
        totalTokens: tokensTotal[account.id] ?? 0,
      };
    }),
    channels: channels.map((channel) => ({
      id: channel.id,
      label: channel.label,
      idPrefix: channel.idPrefix,
      multiAccount: channel.multiAccount !== false,
      canLogin: typeof channel.login === 'function',
      canLogout: typeof channel.logoutOf === 'function',
      canRotateDevice: typeof channel.rotateDeviceIdOf === 'function',
      canVerify: typeof channel.probe === 'function',
      reportsTokens: channel.reportsTokens !== false,
      accounts: accountsOf(channel.id).map((account) => account.id),
    })),
  });
});

accountsRoutes.post('/api/accounts/:channel/login', (c) => {
  const channel = channelById(c.req.param('channel'));
  if (!channel) return c.json({ error: { message: `没有通道 ${c.req.param('channel')}`, type: 'not_found' } }, 404);
  const result = startLogin(channel);
  if (!result.ok || !result.task) return c.json({ error: { message: result.error || '登录启动失败', type: 'bad_request' } }, 400);
  return c.json({ ok: true, task: publicTask(result.task) });
});

accountsRoutes.get('/api/accounts/:channel/login/:taskId', (c) => {
  const task = getLoginTask(c.req.param('channel'), c.req.param('taskId'));
  if (!task) return c.json({ error: { message: '没有这个登录任务（可能已过期，重新发起一次）', type: 'not_found' } }, 404);
  return c.json(publicTask(task));
});

accountsRoutes.post('/api/accounts/:channel/login/:taskId/answer', async (c) => {
  const channelId = c.req.param('channel');
  const taskId = c.req.param('taskId');
  let body: any;
  try {
    body = JSON.parse((await c.req.text()) || '{}');
  } catch (error: any) {
    return c.json({ error: { message: `请求体不是合法 JSON：${error.message}`, type: 'bad_request' } }, 400);
  }
  const value = typeof body?.value === 'string' ? body.value.trim() : '';
  if (!value) return c.json({ error: { message: '需要一个 value', type: 'bad_request' } }, 400);
  if (!getLoginTask(channelId, taskId)) {
    return c.json({ error: { message: '没有这个登录任务', type: 'not_found' } }, 404);
  }
  if (!answerLoginPrompt(channelId, taskId, value)) {
    return c.json({ error: { message: '这个任务当前不在等输入', type: 'bad_request' } }, 400);
  }
  return c.json({ ok: true });
});

accountsRoutes.post('/api/accounts/:id/verify', async (c) => {
  const found = accountWithChannel(c.req.param('id'));
  if (!found) return c.json({ error: { message: `没有账号 ${c.req.param('id')}`, type: 'not_found' } }, 404);
  if (typeof found.channel.probe !== 'function') {
    return c.json({ error: { message: `${found.channel.label} 没有实现凭据检测`, type: 'bad_request' } }, 400);
  }
  try {
    const profile = await found.channel.probe(found.account);
    updateAccount(found.account.id, { profile: { ...found.account.profile, ...profile } });
    markReady(found.account.id);
    return c.json({ ok: true, profile });
  } catch (error: any) {
    if (isCredentialError(error) && error.permanent) markInvalid(found.account.id, error.message);
    return c.json({ error: { message: error.message, type: 'upstream_error' } }, 502);
  }
});

accountsRoutes.patch('/api/accounts/:id', async (c) => {
  const found = accountWithChannel(c.req.param('id'));
  if (!found) return c.json({ error: { message: `没有账号 ${c.req.param('id')}`, type: 'not_found' } }, 404);
  let body: any;
  try {
    body = JSON.parse(await c.req.text());
  } catch (error: any) {
    return c.json({ error: { message: `请求体不是合法 JSON：${error.message}`, type: 'bad_request' } }, 400);
  }
  if (typeof body?.label === 'string' && body.label.trim() !== '') {
    updateAccount(found.account.id, { label: body.label.trim() });
  }
  if (typeof body?.status === 'string') {
    if (body.status === 'disabled' || body.status === 'ready') {
      setStatus(found.account.id, body.status, { message: body.status === 'disabled' ? '管理台手动停用' : undefined });
    } else {
      return c.json({ error: { message: `不能把账号状态直接设成 ${body.status}`, type: 'bad_request' } }, 400);
    }
  }
  const next = getAccount(found.account.id);
  return c.json({ ok: true, account: next });
});

accountsRoutes.delete('/api/accounts/:id', (c) => {
  const id = c.req.param('id');
  if (!removeAccount(id)) return c.json({ error: { message: `没有账号 ${id}`, type: 'not_found' } }, 404);
  log(`账号 ${id} 已删除`);
  return c.json({ ok: true, removed: id });
});

accountsRoutes.get('/api/accounts/:id', (c) => {
  const found = accountWithChannel(c.req.param('id'));
  if (!found) return c.json({ error: { message: `没有账号 ${c.req.param('id')}`, type: 'not_found' } }, 404);
  const { account, channel } = found;
  return c.json({
    account: {
      id: account.id,
      channelId: account.channelId,
      channelLabel: channel.label,
      idPrefix: channel.idPrefix,
      seq: account.seq,
      label: account.label,
      status: account.status,
      statusMessage: account.statusMessage,
      cooldownUntil: account.cooldownUntil,
      profile: account.profile,
      createdAt: account.createdAt,
      hasCredential: Boolean(account.credential),
      credentialSource: account.credential?.source ?? null,
      tokenExpiresAt: account.credential?.expiresAt ? new Date(account.credential.expiresAt).toISOString() : null,
    },
    channel: {
      id: channel.id,
      label: channel.label,
      idPrefix: channel.idPrefix,
      identity: channel.identity,
      multiAccount: channel.multiAccount !== false,
      canLogin: typeof channel.login === 'function',
      canLogout: typeof channel.logoutOf === 'function',
      canRotateDevice: typeof channel.rotateDeviceIdOf === 'function',
      canVerify: typeof channel.probe === 'function',
      canCheckin: typeof channel.checkinClaimOf === 'function',
      reportsTokens: channel.reportsTokens !== false,
    },
  });
});

accountsRoutes.get('/api/accounts/:id/credits', async (c) => {
  const found = accountWithChannel(c.req.param('id'));
  if (!found) return c.json({ error: { message: `没有账号 ${c.req.param('id')}`, type: 'not_found' } }, 404);
  return c.json(await buildCredits(found.channel, found.account));
});

accountsRoutes.get('/api/accounts/:id/usage', async (c) => {
  const found = accountWithChannel(c.req.param('id'));
  if (!found) return c.json({ error: { message: `没有账号 ${c.req.param('id')}`, type: 'not_found' } }, 404);
  return c.json(await usageSummary({ account: found.account.id }));
});

accountsRoutes.get('/api/accounts/:id/badge', async (c) => {
  const found = accountWithChannel(c.req.param('id'));
  if (!found) return c.json({ error: { message: `没有账号 ${c.req.param('id')}`, type: 'not_found' } }, 404);
  c.header('Cache-Control', 'no-store');
  return c.json(await buildBadge(found.channel, found.account));
});

accountsRoutes.get('/api/accounts/:id/checkin', async (c) => {
  const found = accountWithChannel(c.req.param('id'));
  if (!found) return c.json({ error: { message: `没有账号 ${c.req.param('id')}`, type: 'not_found' } }, 404);
  return c.json(await checkinEnvelope(found.account, found.channel));
});

accountsRoutes.post('/api/accounts/:id/checkin', async (c) => {
  const found = accountWithChannel(c.req.param('id'));
  if (!found) return c.json({ error: { message: `没有账号 ${c.req.param('id')}`, type: 'not_found' } }, 404);
  if (typeof found.channel.checkinClaimOf !== 'function') {
    return c.json({ error: { message: `${found.channel.label} 不支持签到`, type: 'bad_request' } }, 400);
  }
  let record;
  try {
    record = await found.channel.checkinClaimOf(found.account);
  } catch (error: any) {
    record = { date: '', status: 'error', message: error.message };
  }
  appendCheckinLog({
    ts: Date.now(),
    account: found.account.id,
    channel: found.channel.id,
    status: record.status,
    credits: typeof record.credits === 'number' ? record.credits : null,
    streakDays: typeof record.streakDays === 'number' ? record.streakDays : null,
    message: record.message ?? null,
    source: 'manual',
  });
  return c.json({ ok: record.status === 'checked' || record.status === 'already', result: record });
});

async function checkinEnvelope(account: Account, channel: any) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const last = channel.lastCheckinOf?.(account) ?? null;
  let status = null;
  let error: string | undefined;
  if (typeof channel.checkinStatusOf === 'function') {
    try {
      status = await channel.checkinStatusOf(account);
    } catch (err: any) {
      error = err.message;
    }
  }
  return { ok: true, today, last, status, error, canClaim: typeof channel.checkinClaimOf === 'function' };
}
