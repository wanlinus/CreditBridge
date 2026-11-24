<script setup lang="ts">
/**
 * 签到状态徽标——**六档映射只在这里**。
 *
 * v2 有两套措辞（账号详情页说「已签到 / 今天已领过 / 未开放 / 签到失败」，签到日志页
 * 说「已签 / 已签过 / 未开放 / 失败」），同一个状态两个说法。这里定死一套。
 *
 * 两处的颜色是刻意的：
 *
 * - `already` 用**绿色**：它**不是错误**——今天已经领过了，再点也不会有新积分，
 *   但账是平的。用灰色会让人以为「没签到」。
 * - `pending` 用**灰色 + 不是「失败」**：那是「今天这一轮还没开始」（Qoder 的活动
 *   每天 10:00 才开窗口）。把它显示成失败会让人以为系统坏了；显示成已签又会让人
 *   以为今天没戏了。它是个**中间状态**，词也要中性。
 * - `skipped` 也用**灰色**：那是用户自己关掉了自动签到（两级开关），不是系统出错，
 *   也不该鼓励人去「修」它。措辞用「已跳过」，比「未开放」更贴近「因为我们关掉了」。
 */
import { computed } from 'vue';

import type { CheckinOutcome } from '@/api/checkin';
import ToneBadge from '@/components/ToneBadge.vue';

const props = defineProps<{
  status: CheckinOutcome | string;
  /** 悬停解释（上游原文放这里）。 */
  title?: string | null;
}>();

const label = computed(() => {
  if (props.status === 'checked') return '已签到';
  if (props.status === 'already') return '今天已领过';
  if (props.status === 'pending') return '未到时间';
  if (props.status === 'disabled') return '未开放';
  if (props.status === 'skipped') return '已跳过';
  return '失败';
});

const tone = computed<'ok' | 'bad' | 'muted'>(() => {
  if (props.status === 'checked' || props.status === 'already') return 'ok';
  // `pending` / `disabled` / `skipped` 都不是失败，用中性色。
  if (props.status === 'pending' || props.status === 'disabled' || props.status === 'skipped') return 'muted';
  return 'bad';
});
</script>

<template>
  <ToneBadge :tone="tone" :label="label" :title="title" />
</template>
