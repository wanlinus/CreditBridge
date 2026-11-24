<script setup lang="ts">
/**
 * 账号状态徽标。
 *
 * **四档映射只在这里**：`ready` / `cooldown`（带「限流至 HH:mm」）/ `disabled` / 其它一律
 * 当 `invalid`。v2 里这个函数散在 `layout.ts`、`account-detail.ts`、`checkin-log.ts`
 * 三处，措辞还不一致——组件化正是收它的地方。
 *
 * 颜色不在这里定义，交给 `ToneBadge`（那是视觉，全站只有一份）。
 */
import { computed } from 'vue';
import { fmtClock } from '@/utils/format';
import ToneBadge from '@/components/ToneBadge.vue';

const props = defineProps<{
  status: string;
  cooldownUntil?: number | null;
  /** 鼠标悬停解释。上游原文（比如 429 的提示）放这里。 */
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
