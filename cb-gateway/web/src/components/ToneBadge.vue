<script setup lang="ts">
withDefaults(
  defineProps<{
    tone: 'ok' | 'warn' | 'bad' | 'muted';
    label: string;
    title?: string | null;
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
