<script setup lang="ts">
/**
 * iOS 那类开关。
 *
 * 为什么不用 `<input type="checkbox">`：模型页一行里已经有三个控件（勾选、上下文、
 * 思考强度），系统复选框和原生下拉挤在一起时**视觉重量分不出主次**。开关是「这一个
 * 模型要不要暴露给 DSH」这个二值决定的自然形状，也和上面的页签、右边的下拉区隔开了。
 *
 * 用 `<button role="switch">` 而不是复选盒：原生 checkbox 想做得像 iOS 得藏掉本体、
 * 再拼两个伪元素，屏幕阅读器读到的是「复选框」；`role="switch"` 读到的是「开关」，
 * 语义对得上。
 */
const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    disabled?: boolean;
    /** 无障碍名字；视觉上不显示，图标/文案由调用方在旁边排。 */
    label?: string;
  }>(),
  { disabled: false, label: '' },
);

const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void }>();

function toggle(): void {
  if (props.disabled) return;
  emit('update:modelValue', !props.modelValue);
}
</script>

<template>
  <button
    type="button"
    role="switch"
    class="switch"
    :class="{ on: modelValue }"
    :aria-checked="modelValue"
    :aria-label="label || undefined"
    :disabled="disabled"
    @click="toggle"
  >
    <span class="knob" />
  </button>
</template>

<style scoped>
.switch {
  position: relative;
  flex: none;
  width: 36px;
  height: 21px;
  padding: 0;
  border: 0;
  border-radius: 99px;
  background: var(--line);
  cursor: pointer;
  transition: background 0.16s ease;
}

/* 打开就是 iOS 的绿。关掉用 --line（浅灰），不是红色——「关掉」不等于「出错」。 */
.switch.on {
  background: var(--ok);
}

.switch:disabled {
  opacity: 0.45;
  cursor: default;
}

.switch:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 17px;
  height: 17px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(16, 24, 40, 0.28);
  transition: transform 0.16s ease;
}

.switch.on .knob {
  transform: translateX(15px);
}
</style>
