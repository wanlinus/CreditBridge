// 订阅网关的 SSE 事件流（`GET /api/events`），断线自动重连。
//
// 为什么插件要维持一条长连接而不是轮询：Trae 登录从「用户点登录」到「浏览器跳回
// 环回地址」可能只有两三秒（浏览器里已经登录过 trae.cn 的时候）。轮询间隔哪怕缩到
// 3 秒也可能错过——而错过的表现是「授权完成但没人接」，用户只看到登录失败，看不出
// 是插件还没来得及开通道。
//
// 断开就重连（退避到固定间隔），断线期间的事件不补发：网关那边也没有重放队列，
// 这是刻意的——插件没连着的时候用户本来也开不了登录通道。

/** 重连间隔。网关重启、网络抖动都靠它自愈，不需要人管。 */
const RECONNECT_MS = 5000;
/** 单次读超时。超过这个时间没有任何数据（连保活注释都没有）就主动重连。 */
const READ_TIMEOUT_MS = 90_000;

/**
 * 起一条事件流。
 *
 * @param {object} options
 * @param {string} options.baseUrl 网关地址（不带尾斜杠）
 * @param {string} options.apiToken Bearer key
 * @param {(event: any) => void} options.onEvent 收到一个事件时调用
 * @param {(line: string) => void} options.log 诊断日志
 * @returns {{stop: () => void, connected: () => boolean}}
 */
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
      // 正常结束（网关关了）也走重连。
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

    /**
     * 读超时用看门狗而不是 `Promise.race(reader.read(), 定时器)`。
     *
     * 那个写法有个隐蔽的坑：定时器赢了之后，那一侧还在挂着的 `read()` 并没有取消，
     * 等它真的拿到数据时已经没人在听——**数据被吞掉**。这里改成「读照常 await，
     * 定时器只负责在超时时 abort 掉整条连接」，数据不会被丢。
     */
    let watchdog = null;
    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        log('事件流长时间没数据（连保活都没有），主动重连');
        try {
          controller?.abort();
        } catch {
          /* 已经断了 */
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
        // SSE 以空行分隔事件；行尾可能是 \r\n，统一按 \n 处理。
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const rawLine = buffer.slice(0, index).replace(/\r$/u, '');
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf('\n');

          if (rawLine === '') {
            // 空行 = 一个事件结束。只有带 data 的才派发（注释行、纯 event 行都丢掉）。
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
          if (rawLine.startsWith(':')) continue; // 保活注释
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
        /* 已经释放 */
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
        /* 已经断了 */
      }
    },
    connected() {
      return connected;
    },
  };
}
