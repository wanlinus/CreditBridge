<script setup lang="ts">
/**
 * 指标卡：`label` / `value` / `note` 三段。对应 v2 的 `.metric`。
 *
 * `note` 用插槽而不是字符串 prop，因为它常带 `<code>` 之类的行内标签
 * （比如「余额来自上游接口」那段说明）。
 *
 * 数字字形（`tabular-nums`）无条件加在 `.value` 上——早先有个 `numeric` prop 控制它，
 * 但全仓没有一个调用方传过，而且 `.value` 自己已经写了 `font-variant-numeric`，
 * 传不传渲染完全一样。删掉它，少一个没人用的开关。
 */
defineProps<{
  label: string;
  value: string;
}>();
</script>

<template>
  <div class="metric">
    <div class="label">{{ label }}</div>
    <div class="value">{{ value }}</div>
    <div class="note"><slot name="note" /></div>
  </div>
</template>

<style scoped>
.metric {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 14px 16px;
}

.label {
  color: var(--muted);
  font-size: 12px;
  margin-bottom: 4px;
}

.value {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.3px;
  font-variant-numeric: tabular-nums;
}

.note {
  color: var(--muted);
  font-size: 12px;
  margin-top: 3px;
}
</style>
