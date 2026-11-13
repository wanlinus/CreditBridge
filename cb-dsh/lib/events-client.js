const RECONNECT_MS = 5000;
const READ_TIMEOUT_MS = 90_000;

export function startEventStream({ baseUrl, apiToken, onEvent, log }) {
  let stopped = false;
  let controller = null;
  let retryTimer = null;
  let connected = false;

  function scheduleReconnect() {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, RECONNECT_MS);
    retryTimer.unref?.();
  }

  async function connect() {
    if (stopped) return;
    controller = new AbortController();
    try {
      const response = await fetch(`${baseUrl}/api/events`, {
        headers: { Authorization: `Bearer ${apiToken}`, Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        log(`事件流连不上（HTTP ${response.status}），${RECONNECT_MS / 1000} 秒后重试`);
        scheduleReconnect();
        return;
      }
      connected = true;
      log('事件流已连接');
      await readStream(response.body);
      connected = false;
      log('事件流结束，准备重连');
      scheduleReconnect();
    } catch (error) {
      connected = false;
      if (stopped) return;
      log(`事件流断开：${error && error.message ? error.message : error}`);
      scheduleReconnect();
    }
  }

  async function readStream(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventName = '';
    let dataLines = [];

    let watchdog = null;
    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        log('事件流长时间没数据（连保活都没有），主动重连');
        try {
          controller?.abort();
        } catch {
        }
      }, READ_TIMEOUT_MS);
      watchdog.unref?.();
    };

    try {
      armWatchdog();
      while (!stopped) {
        const chunk = await reader.read();
        if (!chunk || chunk.done) return;
        armWatchdog();

        buffer += decoder.decode(chunk.value, { stream: true });
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const rawLine = buffer.slice(0, index).replace(/\r$/u, '');
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf('\n');

          if (rawLine === '') {
            if (dataLines.length > 0) {
              const payload = dataLines.join('\n');
              try {
                onEvent({ ...JSON.parse(payload), __event: eventName || 'message' });
              } catch (error) {
                log(`事件解析失败（${eventName || 'message'}）：${error.message}`);
              }
            }
            eventName = '';
            dataLines = [];
            continue;
          }
          if (rawLine.startsWith(':')) continue;
          const colon = rawLine.indexOf(':');
          const field = colon < 0 ? rawLine : rawLine.slice(0, colon);
          let value = colon < 0 ? '' : rawLine.slice(colon + 1);
          if (value.startsWith(' ')) value = value.slice(1);
          if (field === 'event') eventName = value;
          else if (field === 'data') dataLines.push(value);
        }
      }
    } finally {
      if (watchdog) clearTimeout(watchdog);
      try {
        reader.releaseLock();
      } catch {
      }
    }
  }

  connect();

  return {
    stop() {
      stopped = true;
      connected = false;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      try {
        controller?.abort();
      } catch {
      }
    },
    connected() {
      return connected;
    },
  };
}
