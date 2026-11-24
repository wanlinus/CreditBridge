<script setup lang="ts">
/**
 * 请求状态徽标。
 *
 * `499` 有一条特殊语义，**必须单独处理**：它是网关沿用的 nginx 约定
 * （`client closed request`）——请求已经发到上游了，但流没读完客户端就断开
 * （用户点停止 / 切模型 / 客户端自己放弃）。**用量照记**，所以它既不是服务端错误，
 * 也不是「没发生」。v2 的注释写得很清楚：标红会让人去查一个不存在的问题。
 *
 * 所以：499 → **绿色**「499 中断」+ `title` 解释；`>=400` 才红。
 */
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
