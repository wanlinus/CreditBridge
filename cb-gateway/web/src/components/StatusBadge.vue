<script setup lang="ts">
import { computed } from 'vue';
import { fmtClock } from '@/utils/format';
import ToneBadge from '@/components/ToneBadge.vue';

const props = defineProps<{
  status: string;
  cooldownUntil?: number | null;
  title?: string | null;
}>();

const tone = computed<'ok' | 'warn' | 'bad' | 'muted'>(() => {
  if (props.status === 'ready') return 'ok';
  if (props.status === 'cooldown') return 'warn';
  if (props.status === 'disabled') return 'muted';
  return 'bad';
});

const label = computed(() => {
  if (props.status === 'ready') return '就绪';
  if (props.status === 'cooldown') return `限流至 ${fmtClock(props.cooldownUntil)}`;
  if (props.status === 'disabled') return '已停用';
  return '凭据失效';
});
</script>

<template>
  <ToneBadge :tone="tone" :label="label" :title="title" />
</template>
