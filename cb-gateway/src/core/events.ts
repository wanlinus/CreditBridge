// 进程内事件总线：网关 → 插件（cb-dsh）的单向推送。
//
// Trae 登录的回调必须是「浏览器所在机器的环回地址」，而网关在容器里，插件要在用户点「登录」
// 的那一刻就知道该开端口转发——轮询的时延会让「授权完成却没人接」变成常态。
// 刻意做得极薄：没有队列、没有重放、没有持久化。

export interface GatewayEvent {
  type: string;
  [key: string]: unknown;
}

type Listener = (event: GatewayEvent) => void;

const listeners = new Set<Listener>();

/** 返回取消订阅的函数：订阅者成对清理，漏一次就是泄漏一个闭包。 */
export function subscribeEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** **单个订阅者抛错不能影响其它人**——一个坏连接不该让通知传不到别人那里。 */
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

export function resetEventBusForTests(): void {
  listeners.clear();
}
