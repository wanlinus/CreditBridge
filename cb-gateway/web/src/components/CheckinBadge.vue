<script setup lang="ts">
import { computed } from 'vue';

import type { CheckinOutcome } from '@/api/checkin';
import ToneBadge from '@/components/ToneBadge.vue';

const props = defineProps<{
  status: CheckinOutcome | string;
  title?: string | null;
}>();

const label = computed(() => {
  if (props.status === 'checked') return '已签到';
  if (props.status === 'already') return '今天已领过';
  if (props.status === 'pending') return '未到时间';
  if (props.status === 'disabled') return '未开放';
  return '失败';
});

const tone = computed<'ok' | 'bad' | 'muted'>(() => {
  if (props.status === 'checked' || props.status === 'already') return 'ok';
  if (props.status === 'pending' || props.status === 'disabled') return 'muted';
  return 'bad';
});
</script>

<template>
  <ToneBadge :tone="tone" :label="label" :title="title" />
</template>
