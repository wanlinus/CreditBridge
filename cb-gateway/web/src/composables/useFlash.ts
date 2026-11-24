/**
 * 一条会自己消失的提示（「已停用」「复制失败」这类）。
 *
 * ## 为什么抽出来
 *
 * 全量审查时发现这段「一个 ref + 一个 say + 一个 setTimeout + 卸载时清定时器」
 * 在五个组件里各写了一遍，而且**超时时长还不一样**（4 秒 / 6 秒），
 * 没有理由不一样——那是复制粘贴的痕迹，不是设计。
 *
 * 卸载清理放在这里，调用方就不会漏；漏了的表现是「切页之后控制台报
 * setState on unmounted component」，不影响用户，所以永远没人修。
 */
import { onBeforeUnmount, ref, type Ref } from 'vue';

export type FlashTone = 'ok' | 'bad';

export interface FlashMessage {
  text: string;
  tone: FlashTone;
}

export interface FlashOptions {
  /** 停留多久（毫秒）。默认 4 秒；需要人读完一句长话时可以调长。 */
  duration?: number;
}

export function useFlash(options: FlashOptions = {}): { flash: Ref<FlashMessage | null>; say: (text: string, tone?: FlashTone) => void } {
  const duration = options.duration ?? 4000;
  const flash = ref<FlashMessage | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;

  function say(text: string, tone: FlashTone = 'ok'): void {
    flash.value = { text, tone };
    // 连点两次按钮时，后一条要顶掉前一条的倒计时。
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
