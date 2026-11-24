// 进程内事件总线：网关 → 插件（cb-dsh）的单向推送。
//
// 存在的理由：Trae 登录的回调必须是「浏览器所在机器的环回地址」，而网关在容器里。
// 插件要在用户点「登录」的那一刻就知道该开端口转发，轮询的时延会让「授权完成却没人
// 接」变成常态，所以用 SSE 长连接即时推送。
//
// 刻意做得极薄：没有队列、没有重放、没有持久化。订阅者断线期间的事件就丢了——插件
// 没连着的时候用户本来也开不了登录通道。

/** `type` 决定消费方怎么解释其余字段。 */
export interface GatewayEvent {
  type: string;
  [key: string]: unknown;
}

type Listener = (event: GatewayEvent) => void;

const listeners = new Set<Listener>();

/** 返回取消订阅的函数：订阅者总是在 cancel/dispose 里成对清理，漏一次就是泄漏一个闭包。 */
export function subscribeEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 广播。**单个订阅者抛错不能影响其它人**——一个坏连接不该让通知传不到别人那里。 */
export function publishEvent(event: GatewayEvent): number {
  let delivered = 0;
  for (const listener of listeners) {
    try {
      listener(event);
      delivered += 1;
    } catch {
      // 订阅者自己负责记录（SSE 路由会在 enqueue 失败时退订）。
    }
  }
  return delivered;
}

export function subscriberCount(): number {
  return listeners.size;
}

/** 测试用。 */
export function resetEventBusForTests(): void {
  listeners.clear();
}
