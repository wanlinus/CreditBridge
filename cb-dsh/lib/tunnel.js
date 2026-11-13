import net from 'node:net';

const forwards = new Map();

export function isLoopbackHost(host) {
  const value = String(host || '').toLowerCase().replace(/^\[|\]$/gu, '');
  return value === 'localhost' || value === '::1' || /^127\./u.test(value);
}

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
    if (existing.targetHost === targetHost && existing.targetPort === destPort) {
      return Promise.resolve({ ok: true, port: listenPort });
    }
    closeForward(listenPort);
  }

  return new Promise((resolve) => {
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

export function closeForward(port) {
  const listenPort = Number(port);
  const entry = forwards.get(listenPort);
  if (!entry) return false;
  forwards.delete(listenPort);
  for (const socket of entry.sockets) {
    try {
      socket.destroy();
    } catch {
    }
  }
  try {
    entry.server.close();
  } catch {
  }
  return true;
}

export function closeAll() {
  for (const port of [...forwards.keys()]) closeForward(port);
}

export function listForwards() {
  return [...forwards.entries()].map(([port, entry]) => ({
    port,
    targetHost: entry.targetHost,
    targetPort: entry.targetPort,
  }));
}
