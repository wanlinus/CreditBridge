import { onBeforeUnmount, ref, type Ref } from 'vue';

export type FlashTone = 'ok' | 'bad';

export interface FlashMessage {
  text: string;
  tone: FlashTone;
}

export interface FlashOptions {
  duration?: number;
}

export function useFlash(options: FlashOptions = {}): { flash: Ref<FlashMessage | null>; say: (text: string, tone?: FlashTone) => void } {
  const duration = options.duration ?? 4000;
  const flash = ref<FlashMessage | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;

  function say(text: string, tone: FlashTone = 'ok'): void {
    flash.value = { text, tone };
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      flash.value = null;
      timer = null;
    }, duration);
  }

  onBeforeUnmount(() => {
    if (timer) clearTimeout(timer);
    timer = null;
  });

  return { flash, say };
}
