<script setup lang="ts">
/**
 * 语义色徽标：**四档颜色的唯一出口**。
 *
 * 2026-11-13 全量审查时发现，这个胶囊样式在五处各写了一遍
 * （`StatusBadge`、`CheckinBadge`、`RequestStatusBadge`、`KeyRow`、`LoginTaskPanel`），
 * 每处都重新定义「四档 → 哪两个 CSS 变量」。变量本身是共用的，但**结构**是重复的：
 * 任何一处漏了 `warn`，那个状态就会静默变成默认色，而没有人会发现。
 *
 * 现在这里只有这一份：
 *   - 哪个状态算哪一档，由各自的 `XxxBadge` 决定（那是语义，属于业务）
 *   - 哪一档长什么样，只在这里决定（那是视觉）
 */
withDefaults(
  defineProps<{
    tone: 'ok' | 'warn' | 'bad' | 'muted';
    label: string;
    title?: string | null;
    /** 数字类的徽标（状态码）用等宽数字，避免相邻两行对不齐。 */
    mono?: boolean;
  }>(),
  { title: null, mono: false },
);
</script>

<template>
  <span class="badge" :class="[tone, { mono }]" :title="title || undefined">{{ label }}</span>
</template>

<style scoped>
.badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 99px;
  font-size: 12px;
  white-space: nowrap;
}

.mono {
  font-variant-numeric: tabular-nums;
}

.ok {
  background: var(--ok-bg);
  color: var(--ok);
}

.warn {
  background: var(--warn-bg);
  color: var(--warn);
}

.bad {
  background: var(--bad-bg);
  color: var(--bad);
}

.muted {
  background: var(--muted-bg);
  color: var(--muted);
}
</style>
