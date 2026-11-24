// 本机 TCP 环回转发：把 `127.0.0.1:<port>` 转到网关的 `<host>:<port>`。
//
// 为什么要它：Trae 的授权页只肯把浏览器跳回**环回**地址，而网关跑在服务器/容器里、
// 浏览器跑在用户笔记本上。`auth_callback_url` 填内网 IP 时 Trae 侧不跳（2026-11-09
// 实测两次），所以必须有人在**浏览器那台机器**上把 127.0.0.1:<port> 接住再转过去。
//
// 为什么是纯 TCP 而不是 spawn `ssh -N -L`：
//   · 不依赖 ssh 二进制、密钥、known_hosts，Windows 上也一样跑；
//   · 不用管子进程的存活/回收/僵尸，一切都在同一个 Node 里；
//   · 回调本身就是 HTTP over TCP，纯字节转发足够，不需要懂协议。
//
// **目标不能是「同主机同端口的环回」**：`127.0.0.1:18801 → 127.0.0.1:18801` 会把
// 连接接回自己，一个请求就能把进程绕死。网关就在本机时（`gatewayBase` 是 127.0.0.1）
// 恰好就是这个情形，所以直接拒绝——那种部署本来也不需要转发。

import net from 'node:net';

/** 正在跑的转发：监听端口 → 目标 + 服务器 + 活的连接。 */
const forwards = new Map();

/** 判断一个主机名是不是环回（转发目标用）。 */
export function isLoopbackHost(host) {
  const value = String(host || '').toLowerCase().replace(/^\[|\]$/gu, '');
  return value === 'localhost' || value === '::1' || /^127\./u.test(value);
}

/**
 * 开一个转发。已经开着同一个端口时**幂等返回 ok**（重复的登录事件、插件重载都会
 * 再调一次，不该报错）。
 *
 * @returns {Promise<{ok: true, port: number} | {ok: false, port: number, error: string}>}
 */
export function openForward({ port, targetHost, targetPort }) {
  const listenPort = Number(port);
  const destPort = Number(targetPort);
  if (!Number.isInteger(listenPort) || listenPort <= 0 || listenPort > 65535) {
    return Promise.resolve({ ok: false, port: listenPort, error: `端口不合法：${port}` });
  }
  if (!Number.isInteger(destPort) || destPort <= 0 || destPort > 65535) {
    return Promise.resolve({ ok: false, port: listenPort, error: `目标端口不合法：${targetPort}` });
  }
  if (isLoopbackHost(targetHost) && destPort === listenPort) {
    return Promise.resolve({
      ok: false,
      port: listenPort,
      error: `目标是 ${targetHost}:${destPort}，和监听端口相同，转发会绕回自己；网关在本机时不需要转发`,
    });
  }

  const existing = forwards.get(listenPort);
  if (existing) {
    // 目标变了才重建，否则当成幂等。
    if (existing.targetHost === targetHost && existing.targetPort === destPort) {
      return Promise.resolve({ ok: true, port: listenPort });
    }
    closeForward(listenPort);
  }

  return new Promise((resolve) => {
    /** 这个转发开出来的连接，关的时候要一起掐掉，不然会漏掉半开的 socket。 */
    const sockets = new Set();
    const server = net.createServer((client) => {
      sockets.add(client);
      const upstream = net.connect({ host: targetHost, port: destPort });
      sockets.add(upstream);

      const drop = () => {
        client.destroy();
        upstream.destroy();
        sockets.delete(client);
        sockets.delete(upstream);
      };

      client.on('error', drop);
      upstream.on('error', drop);
      client.on('close', drop);
      upstream.on('close', drop);
      // 两个方向的字节原样搬运。
      client.pipe(upstream);
      upstream.pipe(client);
    });

    server.once('error', (error) => {
      forwards.delete(listenPort);
      resolve({ ok: false, port: listenPort, error: `监听 ${listenPort} 失败：${error.message}` });
    });

    server.listen(listenPort, '127.0.0.1', () => {
      forwards.set(listenPort, { targetHost, targetPort: destPort, server, sockets });
      resolve({ ok: true, port: listenPort });
    });
  });
}

/** 关掉某个端口的转发（幂等）。返回是否真的关掉了一个。 */
export function closeForward(port) {
  const listenPort = Number(port);
  const entry = forwards.get(listenPort);
  if (!entry) return false;
  forwards.delete(listenPort);
  for (const socket of entry.sockets) {
    try {
      socket.destroy();
    } catch {
      /* 已经断了 */
    }
  }
  try {
    entry.server.close();
  } catch {
    /* 已经关了 */
  }
  return true;
}

/** 关掉所有转发。插件 dispose 时调。 */
export function closeAll() {
  for (const port of [...forwards.keys()]) closeForward(port);
}

/** 当前在跑的转发，给诊断和测试用。 */
export function listForwards() {
  return [...forwards.entries()].map(([port, entry]) => ({
    port,
    targetHost: entry.targetHost,
    targetPort: entry.targetPort,
  }));
}
