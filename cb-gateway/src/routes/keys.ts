// API key 的管理面：`/api/keys/*`（JSON）。
//
// **没有页面层了**（2026-11-13 SPA 转正）：旧版有一套 `GET /keys` + 五个表单动作，
// 明文靠一次性的内存槽 `pendingSecrets` 经 303 传到列表页（因为明文不能进 URL）。
// 现在 `POST /api/keys` 直接把明文回在响应体里，由前端在页面上展示——那层内存中转
// 连同它的 5 分钟过期逻辑一起删掉了。
//
// 认证：整个模块都在 `auth/middleware.ts` 的闸后面（Bearer 或会话 Cookie）。

import { Hono } from 'hono';

import type { AppEnv } from '../app.ts';
import { createKey, deleteKey, listKeys, updateKey } from '../core/keys.ts';
import { log } from '../logger.ts';
import { readJsonBody } from '../shared/json-body.ts';

export const keysRoutes = new Hono<AppEnv>();

keysRoutes.get('/api/keys', (c) => {
  return c.json({ keys: listKeys() });
});

keysRoutes.post('/api/keys', async (c) => {
  const parsed = await readJsonBody(c);
  if (!parsed.ok) return c.json({ error: { message: parsed.message, type: 'bad_request' } }, 400);
  const { record, secret } = createKey(typeof parsed.body.label === 'string' ? parsed.body.label : '');
  log(`新建 API key ${record.id} (${record.prefix}…) label=${record.label}`);
  // 明文只在这一次响应里出现。调用方是浏览器或脚本，谁拿到谁负责别打日志。
  return c.json({ key: record, secret }, 201);
});

keysRoutes.patch('/api/keys/:id', async (c) => {
  const parsed = await readJsonBody(c);
  if (!parsed.ok) return c.json({ error: { message: parsed.message, type: 'bad_request' } }, 400);
  const next = updateKey(c.req.param('id'), {
    label: typeof parsed.body.label === 'string' ? parsed.body.label : undefined,
    enabled: typeof parsed.body.enabled === 'boolean' ? parsed.body.enabled : undefined,
  });
  if (!next) return c.json({ error: { message: `没有 key ${c.req.param('id')}`, type: 'not_found' } }, 404);
  return c.json({ ok: true, key: next });
});

keysRoutes.delete('/api/keys/:id', (c) => {
  if (!deleteKey(c.req.param('id'))) return c.json({ error: { message: `没有 key ${c.req.param('id')}`, type: 'not_found' } }, 404);
  return c.json({ ok: true, removed: c.req.param('id') });
});
