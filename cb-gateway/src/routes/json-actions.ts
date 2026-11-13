import { Hono } from 'hono';

import type { AppEnv } from '../app.ts';
import { channelById } from '../channels/index.ts';
import { getAccount, updateAccount } from '../core/accounts.ts';
import { cancelLogin, cancelRunningLogins, getLoginTask } from '../core/login-tasks.ts';
import { checkinAllAccounts } from '../core/checkin-scheduler.ts';
import { config, isValidCheckinTime, updateConfig } from '../config.ts';
import {
  changePassword,
  clearCookie,
  createSession,
  destroySession,
  mustChangePassword,
  sessionCookie,
  sessionFromCookie,
  verifyPassword,
} from '../shared/gateway-auth.ts';
import { log } from '../logger.ts';

export const jsonActionRoutes = new Hono<AppEnv>();

async function readJson(c: any): Promise<{ ok: true; body: any } | { ok: false; response: Response }> {
  const raw = await c.req.text();
  if (!raw.trim()) return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch (error: any) {
    return {
      ok: false,
      response: c.json({ error: { message: `请求体不是合法 JSON：${error.message}`, type: 'bad_request' } }, 400),
    };
  }
}

jsonActionRoutes.post('/api/login', async (c) => {
  const parsed = await readJson(c);
  if (!parsed.ok) return parsed.response;
  const username = typeof parsed.body?.username === 'string' ? parsed.body.username : '';
  const password = typeof parsed.body?.password === 'string' ? parsed.body.password : '';
  if (!verifyPassword(username, password)) {
    log(`登录失败（JSON）：${username.slice(0, 32)}`);
    return c.json({ error: { message: '用户名或密码不对', type: 'unauthorized' } }, 401);
  }
  const sid = createSession();
  log(`登录成功（JSON）：${username}`);
  return new Response(JSON.stringify({ ok: true, mustChangePassword: mustChangePassword() }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': sessionCookie(sid),
      'Cache-Control': 'no-store',
    },
  });
});

jsonActionRoutes.post('/api/logout', (c) => {
  const sid = sessionFromCookie(c.req.header('cookie'));
  const removed = sid ? destroySession(sid) : false;
  if (removed) log('会话已退出（JSON）');
  return new Response(JSON.stringify({ ok: true, removed }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': clearCookie(),
      'Cache-Control': 'no-store',
    },
  });
});

jsonActionRoutes.post('/api/password', async (c) => {
  const parsed = await readJson(c);
  if (!parsed.ok) return parsed.response;
  const current = typeof parsed.body?.current === 'string' ? parsed.body.current : '';
  const next = typeof parsed.body?.next === 'string' ? parsed.body.next : '';
  const confirm = typeof parsed.body?.confirm === 'string' ? parsed.body.confirm : '';
  if (next !== confirm) {
    return c.json({ error: { message: '两次输入的新密码不一致', type: 'bad_request' } }, 400);
  }
  const problem = changePassword(current, next);
  if (problem) return c.json({ error: { message: problem, type: 'bad_request' } }, 400);
  log('网关密码已更新（JSON）');
  return c.json({ ok: true });
});

jsonActionRoutes.patch('/api/config', async (c) => {
  const parsed = await readJson(c);
  if (!parsed.ok) return parsed.response;
  const patch: Record<string, unknown> = {};
  if (parsed.body?.checkinTime !== undefined) {
    if (!isValidCheckinTime(parsed.body.checkinTime)) {
      return c.json({ error: { message: '签到时间必须是 HH:MM（24 小时制）', type: 'bad_request' } }, 400);
    }
    patch.checkinTime = parsed.body.checkinTime;
  }
  if (Object.keys(patch).length === 0) {
    return c.json({ error: { message: '没有可改的字段（支持 checkinTime）', type: 'bad_request' } }, 400);
  }
  const result = updateConfig(patch);
  if (!result.ok) return c.json({ error: { message: result.error || '更新失败', type: 'bad_request' } }, 400);
  return c.json({ ok: true, checkinTime: config.checkinTime });
});

jsonActionRoutes.post('/api/checkin/all', async (c) => {
  const results = await checkinAllAccounts();
  const okCount = results.filter((r) => r.status === 'checked' || r.status === 'already').length;
  return c.json({
    results,
    okCount,
    failCount: results.length - okCount,
  });
});

jsonActionRoutes.delete('/api/accounts/:channel/login/:taskId', (c) => {
  const channel = channelById(c.req.param('channel'));
  if (!channel) return c.json({ error: { message: `没有通道 ${c.req.param('channel')}`, type: 'not_found' } }, 404);
  const taskId = c.req.param('taskId');
  const task = getLoginTask(channel.id, taskId);
  const cancelled = cancelLogin(channel.id, taskId);
  return c.json({ ok: true, cancelled, existed: Boolean(task) });
});

jsonActionRoutes.delete('/api/accounts/:channel/login', (c) => {
  const channel = channelById(c.req.param('channel'));
  if (!channel) return c.json({ error: { message: `没有通道 ${c.req.param('channel')}`, type: 'not_found' } }, 404);
  const count = cancelRunningLogins(channel.id);
  return c.json({ ok: true, cancelled: count });
});

jsonActionRoutes.post('/api/accounts/:id/logout', async (c) => {
  const account = getAccount(c.req.param('id'));
  if (!account) return c.json({ error: { message: `没有账号 ${c.req.param('id')}`, type: 'not_found' } }, 404);
  const channel = channelById(account.channelId);
  let upstream: string | null = null;
  if (channel && typeof channel.logoutOf === 'function') {
    try {
      await channel.logoutOf(account);
    } catch (error: any) {
      upstream = error.message;
      log(`${account.id} 上游退出失败：${error.message}`);
    }
  }
  return c.json({ ok: true, upstream, removed: false });
});

jsonActionRoutes.post('/api/accounts/:id/rotate-device', (c) => {
  const account = getAccount(c.req.param('id'));
  if (!account) return c.json({ error: { message: `没有账号 ${c.req.param('id')}`, type: 'not_found' } }, 404);
  const channel = channelById(account.channelId);
  if (!channel || typeof channel.rotateDeviceIdOf !== 'function') {
    return c.json({ ok: true, changed: false, reason: '这个通道不支持换设备号' });
  }
  const patch = channel.rotateDeviceIdOf(account);
  if (!patch) return c.json({ ok: true, changed: false, reason: '没有需要换的字段' });
  updateAccount(account.id, { credential: { ...(account.credential || {}), ...patch } });
  log(`${account.id} 设备号已更换（JSON）：${JSON.stringify(patch)}`);
  return c.json({ ok: true, changed: true, fields: Object.keys(patch) });
});

