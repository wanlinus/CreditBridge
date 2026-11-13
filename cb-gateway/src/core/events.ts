export interface GatewayEvent {
  type: string;
  [key: string]: unknown;
}

type Listener = (event: GatewayEvent) => void;

const listeners = new Set<Listener>();

export function subscribeEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishEvent(event: GatewayEvent): number {
  let delivered = 0;
  for (const listener of listeners) {
    try {
      listener(event);
      delivered += 1;
    } catch {
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
