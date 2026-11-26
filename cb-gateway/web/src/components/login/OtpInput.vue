<script setup lang="ts">
/**
 * OTP 验证码输入：用户从**另一台设备**的通知里读到 6 位数字，回来填。
 *
 * 为什么不用普通输入框：这是「抄写」动作，用户视线要在两个屏幕之间来回跳。
 * 单个大格子 + 等宽字体 + 自动聚焦，能减少「看错位 / 少填一位」这类错。
 *
 * 填满自动提交——用户抄完最后一位就该走，不用再找提交按钮。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';

const props = defineProps<{
  length: number;
  disabled: boolean;
}>();

const emit = defineEmits<{ (e: 'submit', value: string): void }>();

const value = ref('');
const input = ref<HTMLInputElement | null>(null);

/** 把字符串拆成每一位，渲染成一排格子。空格显示为占位点。 */
const cells = computed(() =>
  Array.from({ length: props.length }, (_, index) => value.value[index] ?? ''),
);

const complete = computed(() => value.value.length >= props.length);

function onInput(event: Event): void {
  const el = event.target as HTMLInputElement;
  // 只留数字：用户可能从别处粘贴，带空格或连字符。
  const digits = el.value.replace(/\D/g, '').slice(0, props.length);
  value.value = digits;
  el.value = digits;
}

// 填满就自动提交。等一帧让最后一位先渲染出来，否则用户看不到自己填了什么。
watch(complete, async (done) => {
  if (!done || props.disabled) return;
  await nextTick();
  emit('submit', value.value);
});

/** 外部强制提交（用户不等填满，手动点按钮）。 */
function submitNow(): void {
  if (value.value !== '') emit('submit', value.value);
}

/** 验证失败后清空，让用户重填。父组件用它 `ref.clear()`。 */
function clear(): void {
  value.value = '';
  input.value?.focus();
}

defineExpose({ clear, submitNow });

onMounted(() => input.value?.focus());
</script>

<template>
  <div class="otp">
    <!-- 真正的输入框藏起来，格子和它双向同步。这样焦点、键盘、粘贴都是原生行为。 -->
    <input
      ref="input"
      class="hidden-input"
      type="text"
      inputmode="numeric"
      autocomplete="one-time-code"
      :maxlength="length"
      :disabled="disabled"
      :value="value"
      @input="onInput"
    />
    <div class="cells" role="presentation" @click="input?.focus()">
      <span
        v-for="(char, index) in cells"
        :key="index"
        class="cell"
        :class="{ filled: char !== '', active: index === value.length && !disabled }"
      >{{ char }}</span>
    </div>
    <button type="button" class="btn primary sm submit" :disabled="disabled || !complete" @click="submitNow">
      提交验证码
    </button>
  </div>
</template>

<style scoped>
.otp {
  display: grid;
  gap: 10px;
  justify-items: center;
}

/* 视觉上隐藏但保留可访问性：屏幕阅读器还能读到，焦点也还在它身上。 */
.hidden-input {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

.cells {
  display: flex;
  gap: 8px;
  cursor: text;
}

.cell {
  width: 38px;
  height: 48px;
  display: grid;
  place-items: center;
  font-size: 22px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--fg);
  background: var(--card2);
  border: 1px solid var(--line);
  border-radius: 8px;
  transition:
    border-color 0.12s,
    background 0.12s;
}

.cell.filled {
  background: var(--card);
  border-color: var(--accent);
}

/* 当前该填的那一格高亮。用户一眼知道填到哪了。 */
.cell.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-weak);
}

.submit {
  justify-self: center;
}
</style>
