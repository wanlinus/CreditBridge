<script setup lang="ts">
import { computed } from 'vue';
import ToneBadge from '@/components/ToneBadge.vue';

const props = defineProps<{ status: unknown }>();

const code = computed(() => Number(props.status));
const known = computed(() => Number.isFinite(code.value));

const tone = computed<'ok' | 'bad' | 'muted'>(() => {
  if (!known.value) return 'muted';
  if (code.value === 499) return 'ok';
  return code.value >= 400 ? 'bad' : 'ok';
});

const label = computed(() => {
  if (!known.value) return '—';
  if (code.value === 499) return '499 中断';
  return String(code.value);
});

const hint = computed(() =>
  code.value === 499
    ? '客户端在流读完之前断开了（用户点停止 / 切模型 / 客户端放弃）。请求已发到上游，用量已记账'
    : null,
);
</script>

<template>
  <ToneBadge :tone="tone" :label="label" :title="hint" mono />
</template>
