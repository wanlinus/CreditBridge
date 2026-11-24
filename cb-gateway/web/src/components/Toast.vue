<script setup lang="ts">
/**
 * 右上角的浮动回执（toast）。
 *
 * ## 为什么不用页面里的 `.alert`
 *
 * 页内提示条会**把下面的内容推下去**：点一次「刷新积分」，整页跳一下，卡片位置全变。
 * 一条 6 秒就消失的「已确认 N 个账号」不值得让版面动。
 *
 * ## 为什么不盖住导航栏
 *
 * 顶栏（`ShellLayout` 的 `.nav`）右侧是「版本 · 签到 · 退出」三个可点元素，`top: 16px`
 * 的 toast 正好压在上面——那不叫"显示在右上角"，那叫挡住按钮。所以往下让一档，
 * 落在导航栏下方、内容区右边缘上方；`pointer-events: none` 保证它即使悬在内容上也
 * **点不穿**（用户能照常点下面的按钮）。
 *
 * 水平位置跟内容区右边缘对齐（`.wrap` 是 1120px 居中 + 24px 内边距），宽屏时不会
 * 飘到屏幕最右边只有自己在那儿。
 */
import type { FlashTone } from '@/composables/useFlash';

withDefaults(
  defineProps<{
    text: string;
    /** `ok` 绿、`bad` 红、`warn` 黄。默认 ok。 */
    tone?: FlashTone | 'warn';
  }>(),
  { tone: 'ok' },
);
</script>

<template>
  <Teleport to="body">
    <div class="toast-layer">
      <div :class="['toast', tone]" role="status" aria-live="polite">{{ text }}</div>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-layer {
  position: fixed;
  /* 顶栏大约 55px 高 + 22px 下边距；88px 落在它下方、内容区第一行之上。 */
  top: 88px;
  /* 和 `.wrap` 的右边缘对齐：窄屏用 24px，宽屏跟着内容区走。 */
  right: max(24px, calc((100vw - 1120px) / 2 + 24px));
  z-index: 50;
  /* 关键：这一层永远不接收鼠标事件，悬在内容上也点得穿。 */
  pointer-events: none;
  max-width: min(360px, calc(100vw - 48px));
}

.toast {
  padding: 10px 14px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--card);
  color: var(--fg);
  font-size: 13px;
  line-height: 1.5;
  box-shadow: 0 6px 20px rgba(16, 24, 40, 0.12);
  /* 左边框着色，和页内的 `.alert` 同一套语义。 */
  border-left-width: 3px;
  animation: toast-in 140ms ease-out;
}

.toast.ok {
  border-left-color: var(--ok);
}

.toast.bad {
  border-left-color: var(--bad);
}

.toast.warn {
  border-left-color: var(--warn);
}

@keyframes toast-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* 尊重系统的「减少动态效果」：动效只是锦上添花，不是信息。 */
@media (prefers-reduced-motion: reduce) {
  .toast {
    animation: none;
  }
}
</style>
