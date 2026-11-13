<script setup lang="ts">
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
