// SSE 事件流与诊断打点：网关 → 插件的单向推送。`/plugin-probe` 也在这里——和 SSE 一样是**插件排错用的通道**。
// 单独一个文件是因为 SSE 是整个 admin 里逻辑最重的一块（流生命周期、keepalive、断线清理）。

import fs from 'node:fs';
import path from 'node:path';

import { Hono } from 'hono';

import type { AppEnv } from '../app.ts';
import { log } from '../logger.ts';
import { LOG_DIR } from '../shared/paths.ts';
import { subscribeEvents, subscriberCount, type GatewayEvent } from '../core/events.ts';

export const eventsRoutes = new Hono<AppEnv>();

eventsRoutes.get('/api/plugin-probe', (c) => {
  const stage = new URL(c.req.url).searchParams.get('stage') || '?';
  try {
    fs.appendFileSync(path.join(LOG_DIR, 'plugin-probe.log'), `${new Date().toISOString()} ${stage}\n`);
  } catch {
    /* 只是诊断打点，写不进去不影响请求 */
  }
  return c.json({ ok: true, stage });
});

/** 保活间隔。要短于常见 NAT/代理的空闲超时（60s 起步），30s 是稳妥值。 */
const EVENTS_KEEPALIVE_MS = 30_000;

// SSE 而不是 WebSocket：只需要单向「通知一下」，SSE 是纯 HTTP、零新依赖（对话流式响应本来就是手搓 SSE）。
// **必须有推送**：Trae 授权页只肯跳回环回地址，网关在容器里、浏览器在笔记本上，插件必须**在点「登录」那一刻**
// 就知道（轮询时延会让「授权完成却没人接」变成常态）。断线即丢事件（没有重放）。
eventsRoutes.get('/api/events', (c) => {
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
          // 连接已断但还没收到 cancel：自己收摊，别让订阅者集合里留个死闭包。
          cleanup();
        }
      };
      unsubscribe = subscribeEvents((event: GatewayEvent) => {
        send(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      });
      // 先回一条注释当「握手确认」：客户端据此知道流真的通了，而不是卡在等第一个事件上。
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
    // nginx 之类的反代默认会攒缓冲，SSE 必须显式关掉。
    'X-Accel-Buffering': 'no',
  });
});
