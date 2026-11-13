import { Hono } from 'hono';

import type { AppEnv } from '../app.ts';
import { createKey, deleteKey, listKeys, updateKey } from '../core/keys.ts';
import { log } from '../logger.ts';

export const keysRoutes = new Hono<AppEnv>();

keysRoutes.get('/api/keys', (c) => {
  return c.json({ keys: listKeys() });
});

keysRoutes.post('/api/keys', async (c) => {
  let body: any = {};
  try {
    body = JSON.parse((await c.req.text()) || '{}');
  } catch {
  }
  const { record, secret } = createKey(typeof body?.label === 'string' ? body.label : '');
  log(`新建 API key ${record.id} (${record.prefix}…) label=${record.label}`);
  return c.json({ key: record, secret }, 201);
});

keysRoutes.patch('/api/keys/:id', async (c) => {
  let body: any;
  try {
    body = JSON.parse((await c.req.text()) || '{}');
  } catch (error: any) {
    return c.json({ error: { message: `请求体不是合法 JSON：${error.message}`, type: 'bad_request' } }, 400);
  }
  const next = updateKey(c.req.param('id'), {
    label: typeof body?.label === 'string' ? body.label : undefined,
    enabled: typeof body?.enabled === 'boolean' ? body.enabled : undefined,
  });
  if (!next) return c.json({ error: { message: `没有 key ${c.req.param('id')}`, type: 'not_found' } }, 404);
  return c.json({ ok: true, key: next });
});

keysRoutes.delete('/api/keys/:id', (c) => {
  if (!deleteKey(c.req.param('id'))) return c.json({ error: { message: `没有 key ${c.req.param('id')}`, type: 'not_found' } }, 404);
  return c.json({ ok: true, removed: c.req.param('id') });
});
