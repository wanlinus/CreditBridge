<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import * as echarts from 'echarts/core';
import { BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

import type { ChannelAppearance } from '@/api/channels';
import type { DailyBucket } from '@/api/usage';
import { fmtNum, fmtTokens } from '@/utils/format';

echarts.use([BarChart, GridComponent, TooltipComponent, CanvasRenderer]);

type Dim = 'channel' | 'model' | 'account';
type Metric = 'total' | 'completion';

const props = withDefaults(
  defineProps<{
    daily: DailyBucket[];
    channels?: ChannelAppearance[];
    loading?: boolean;
    dim?: Dim;
  }>(),
  { channels: () => [], loading: false, dim: 'channel' },
);

const emit = defineEmits<{ (e: 'update:dim', dim: Dim): void }>();

const DIMS: { dim: Dim; label: string }[] = [
  { dim: 'channel', label: '按通道' },
  { dim: 'model', label: '按模型' },
  { dim: 'account', label: '按账号' },
];

const DIM_LABEL: Record<Dim, string> = { channel: '通道', model: '模型', account: '账号' };
const METRICS: { metric: Metric; label: string }[] = [
  { metric: 'total', label: '总 Token' },
  { metric: 'completion', label: '仅输出' },
];

const metric = ref<Metric>('total');

function valueOf(bucket: { tokens?: number; completionTokens?: number } | undefined): number {
  const raw = metric.value === 'completion' ? bucket?.completionTokens : bucket?.tokens;
  return Number(raw) || 0;
}
const DIM_FIELD: Record<Dim, 'byProvider' | 'byModel' | 'byAccount'> = {
  channel: 'byProvider',
  model: 'byModel',
  account: 'byAccount',
};
const DIM_LIMIT: Record<Dim, number> = { channel: 6, model: 6, account: 8 };

const OTHER = '\u0000other';

const FALLBACK_PALETTE = ['#2f6df6', '#0f9d8a', '#e08a00', '#8b5cf6', '#e0447c', '#5a9e1e', '#0891b2', '#b45309'];
const FALLBACK_OTHER = '#a3a9b3';

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

let paletteCache: string[] | null = null;
function palette(): string[] {
  if (!paletteCache) {
    paletteCache = FALLBACK_PALETTE.map((fallback, i) => cssVar(`--chart-${i + 1}`, fallback));
  }
  return paletteCache;
}

function otherColor(): string {
  return cssVar('--chart-other', FALLBACK_OTHER);
}

interface Series {
  key: string;
  label: string;
  color: string;
  total: number;
  days: { value: number; requests: number }[];
}

const channelLabels = computed(() => {
  const map = new Map<string, string>();
  for (const c of props.channels) map.set(c.id, c.label);
  return map;
});

function groupKey(raw: string): string {
  return props.dim === 'model' ? raw.toLowerCase() : raw;
}

const prepared = computed(() => {
  const rows = Array.isArray(props.daily) ? props.daily : [];
  const dates = rows.map((row) => String(row?.date ?? ''));
  const field = DIM_FIELD[props.dim];

  const totals = new Map<string, number>();
  const spellingTotals = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const map = row?.[field];
    if (!map) continue;
    for (const [raw, value] of Object.entries(map)) {
      const amount = valueOf(value);
      if (amount <= 0) continue;
      const key = groupKey(raw);
      totals.set(key, (totals.get(key) ?? 0) + amount);
      const variants = spellingTotals.get(key) ?? new Map<string, number>();
      variants.set(raw, (variants.get(raw) ?? 0) + amount);
      spellingTotals.set(key, variants);
    }
  }

  function pickSpelling(key: string): string {
    const variants = spellingTotals.get(key);
    if (!variants) return key;
    let best = '';
    let bestAmount = -1;
    for (const [raw, amount] of variants) {
      if (amount > bestAmount || (amount === bestAmount && raw < best)) {
        best = raw;
        bestAmount = amount;
      }
    }
    return best || key;
  }

  const ranked = [...totals.keys()].sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0));
  const keep = ranked.slice(0, Math.max(1, DIM_LIMIT[props.dim] - 1));
  const keys = ranked.length > keep.length ? [...keep, OTHER] : keep;

  const colors = palette();
  const series: Series[] = keys.map((key, i) => ({
    key,
    label:
      key === OTHER
        ? '其他'
        : props.dim === 'channel'
          ? (channelLabels.value.get(key) ?? key)
          : props.dim === 'model'
            ? pickSpelling(key)
            : key,
    color: key === OTHER ? otherColor() : colors[i % colors.length],
    total: 0,
    days: rows.map(() => ({ value: 0, requests: 0 })),
  }));
  const slot = new Map(keys.map((key, i) => [key, i] as const));

  rows.forEach((row, day) => {
    const map = row?.[field];
    if (!map) return;
    for (const [raw, value] of Object.entries(map)) {
      const amount = valueOf(value);
      if (amount <= 0) continue;
      const at = slot.get(groupKey(raw)) ?? slot.get(OTHER);
      if (at === undefined) continue;
      series[at].days[day].value += amount;
      series[at].days[day].requests += Number(value?.requests) || 0;
    }
  });

  for (const item of series) item.total = item.days.reduce((sum, day) => sum + day.value, 0);

  return { dates, series };
});

const hidden = ref<Set<string>>(new Set());

const visible = computed(() => prepared.value.series.filter((s) => !hidden.value.has(s.key)));

const stats = computed(() => {
  const days = prepared.value.dates.length;
  const perDay = new Array<number>(days).fill(0);
  let sum = 0;
  for (const item of visible.value) {
    sum += item.total;
    item.days.forEach((day, i) => {
      perDay[i] += day.value;
    });
  }
  return {
    sum,
    peak: perDay.length ? Math.max(...perDay) : 0,
    activeDays: perDay.filter((value) => value > 0).length,
  };
});

const overlay = computed(() => {
  if (props.loading) return '读取中…';
  if (prepared.value.series.length === 0) return `这个口径下还没有记录`;
  if (visible.value.length === 0) return '分类全隐藏了，点下面的图例恢复';
  return '';
});

const chartEl = ref<HTMLDivElement | null>(null);
const chart = shallowRef<echarts.ECharts | null>(null);

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function dayTitle(index: number): string {
  const date = prepared.value.dates[index] ?? '';
  const parts = date.split('-').map(Number);
  const [y, m, d] = parts;
  const valid = parts.length === 3 && parts.every((n) => Number.isFinite(n));
  const week = valid ? ` ${WEEKDAYS[new Date(y, m - 1, d).getDay()]}` : '';
  const today = index === prepared.value.dates.length - 1 ? ' · 今天' : '';
  return `${date}${week}${today}`;
}

function fmtAxis(value: number): string {
  if (!Number.isFinite(value)) return '';
  if (Math.abs(value) >= 1e8) return `${Number((value / 1e8).toFixed(2))}亿`;
  if (Math.abs(value) >= 1e4) return `${Number((value / 1e4).toFixed(1))}万`;
  return fmtNum(value, 0);
}

function tickIndexes(count: number): Set<number> {
  if (count <= 2) return new Set(Array.from({ length: count }, (_, i) => i));
  const maxTicks = 6;
  const step = Math.max(1, Math.ceil((count - 1) / (maxTicks - 1)));
  const picked: number[] = [];
  for (let i = 0; i < count - 1; i += step) picked.push(i);
  const last = count - 1;
  if (last - picked[picked.length - 1] < step * 0.6) picked.pop();
  picked.push(last);
  return new Set(picked);
}

function esc(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch);
}

function buildOption() {
  const dates = prepared.value.dates;
  const series = visible.value;
  const count = dates.length;
  const ticks = tickIndexes(count);
  const line = cssVar('--line', '#e2e5ea');
  const muted = cssVar('--muted', '#68707d');
  const accent = cssVar('--accent', '#2563eb');

  return {
    animation: false,
    grid: { top: 10, right: 6, bottom: 2, left: 2, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(37, 99, 235, 0.06)' } },
      backgroundColor: '#fff',
      borderColor: line,
      borderWidth: 1,
      padding: 0,
      confine: true,
      textStyle: { color: '#1f2328', fontSize: 12 },
      extraCssText: 'border-radius:8px;box-shadow:0 6px 24px rgba(16,24,40,.12);',
      formatter: (params: unknown) => {
        const list = Array.isArray(params) ? (params as any[]) : [params as any];
        const index = list[0]?.dataIndex ?? 0;
        const dayTotal = sumVisible(index);
        const rows = list
          .map((item) => ({ item, value: Number(item?.value) || 0 }))
          .filter(({ value }) => value > 0)
          .sort((a, b) => b.value - a.value);

        const head =
          `<div style="padding:8px 12px 6px;font-size:12px;color:${muted};border-bottom:1px solid ${line}">` +
          `${esc(dayTitle(index))}</div>`;

        if (rows.length === 0) {
          return `${head}<div style="padding:10px 12px;color:${muted}">这一天没有用量</div>`;
        }

        const body = rows
          .map(({ item, value }) => {
            const item2 = series[item.seriesIndex];
            const requests = item2?.days[index]?.requests ?? 0;
            const ratio = dayTotal > 0 ? (value / dayTotal) * 100 : 0;
            const pct = ratio >= 1 ? `${Math.round(ratio)}%` : ratio > 0 ? '<1%' : '0%';
            return (
              `<div style="display:flex;align-items:center;gap:6px;padding:2px 12px;line-height:1.6">` +
              `${item.marker}<span style="flex:1;min-width:90px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item2?.label ?? item.seriesName ?? '')}</span>` +
              `<b style="font-variant-numeric:tabular-nums">${fmtTokens(value)}</b>` +
              `<span style="color:${muted};font-size:11px;width:36px;text-align:right">${pct}</span>` +
              `<span style="color:${muted};font-size:11px;width:44px;text-align:right">${fmtNum(requests, 0)} 次</span>` +
              `</div>`
            );
          })
          .join('');

        const foot =
          `<div style="display:flex;justify-content:space-between;gap:16px;margin-top:4px;padding:6px 12px;border-top:1px solid ${line};font-size:12px">` +
          `<span style="color:${muted}">合计</span><b style="font-variant-numeric:tabular-nums">${fmtTokens(dayTotal)}</b></div>`;

        return head + body + foot;
      },
    },
    xAxis: {
      type: 'category',
      data: dates.map((date) => date.slice(5)),
      axisLine: { lineStyle: { color: line } },
      axisTick: { show: false },
      axisLabel: {
        color: muted,
        fontSize: 11,
        interval: (index: number) => ticks.has(index),
        formatter: (value: string, index: number) =>
          index === count - 1 && count > 1 ? `{today|${value}}` : value,
        rich: { today: { color: accent, fontWeight: 'bold' } },
      },
    },
    yAxis: {
      type: 'value',
      splitNumber: 3,
      axisLabel: { color: muted, fontSize: 10, margin: 6, formatter: fmtAxis },
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: line, type: 'dashed' } },
    },
    series: series.map((item) => ({
      name: item.label,
      type: 'bar',
      stack: 'total',
      data: item.days.map((day) => day.value),
      itemStyle: { color: item.color },
      barMaxWidth: 26,
      emphasis: { focus: 'series' },
    })),
  };
}

function sumVisible(index: number): number {
  return visible.value.reduce((sum, item) => sum + (item.days[index]?.value ?? 0), 0);
}

function render() {
  if (!chartEl.value) return;
  if (!chart.value) chart.value = echarts.init(chartEl.value, undefined, { renderer: 'canvas' });
  chart.value.setOption(buildOption(), true);
  if ((chartEl.value.clientWidth ?? 0) > 0) chart.value.resize();
}

let observer: ResizeObserver | null = null;

function onWindowResize() {
  chart.value?.resize();
}

onMounted(() => {
  render();
  if (chartEl.value) {
    observer = new ResizeObserver(() => {
      if ((chartEl.value?.clientWidth ?? 0) > 0) chart.value?.resize();
    });
    observer.observe(chartEl.value);
  }
  window.addEventListener('resize', onWindowResize);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowResize);
  observer?.disconnect();
  observer = null;
  chart.value?.dispose();
  chart.value = null;
});

watch(
  () => props.dim,
  () => {
    hidden.value = new Set();
  },
);

watch(() => [props.daily, props.dim, metric.value, props.channels, props.loading, hidden.value], render, { flush: 'post' });

function toggle(key: string) {
  const next = new Set(hidden.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  hidden.value = next;
}

function showAll() {
  hidden.value = new Set();
}

function pick(dim: Dim) {
  if (dim !== props.dim) emit('update:dim', dim);
}

function pickMetric(next: Metric) {
  if (next !== metric.value) metric.value = next;
}

const ariaLabel = computed(() => `近 ${prepared.value.dates.length} 天用量，按${DIM_LABEL[props.dim]}拆分`);
</script>

<template>
  <div class="trend">
    <div class="head">
      <div class="dim" role="group" aria-label="指标">
        <button
          v-for="item in METRICS"
          :key="item.metric"
          type="button"
          :class="{ on: metric === item.metric }"
          :aria-pressed="metric === item.metric"
          @click="pickMetric(item.metric)"
        >
          {{ item.label }}
        </button>
      </div>

      <div class="dim" role="group" aria-label="拆分口径">
        <button
          v-for="item in DIMS"
          :key="item.dim"
          type="button"
          :class="{ on: props.dim === item.dim }"
          :aria-pressed="props.dim === item.dim"
          @click="pick(item.dim)"
        >
          {{ item.label }}
        </button>
      </div>

      <div class="stats">
        <span>合计 <b>{{ fmtTokens(stats.sum) }}</b></span>
        <span>峰值 <b>{{ fmtTokens(stats.peak) }}</b></span>
        <span><b>{{ stats.activeDays }}</b> 天有用量</span>
      </div>
    </div>

    <div class="plot">
      <div ref="chartEl" class="canvas" role="img" :aria-label="ariaLabel" />
      <div v-if="overlay" class="overlay">{{ overlay }}</div>
    </div>

    <div v-if="prepared.series.length > 0" class="legend">
      <button
        v-for="item in prepared.series"
        :key="item.key"
        type="button"
        class="lg"
        :class="{ off: hidden.has(item.key) }"
        :aria-pressed="!hidden.has(item.key)"
        :title="`${item.label}：近 14 天 ${fmtTokens(item.total)} token（点击隐藏/显示）`"
        @click="toggle(item.key)"
      >
        <span class="sw" :style="{ background: item.color }" />
        <span class="lg-name">{{ item.label }}</span>
        <b>{{ fmtTokens(item.total) }}</b>
      </button>
      <button v-if="hidden.size > 0" type="button" class="lg reset" @click="showAll">全部显示</button>
    </div>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.dim {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  background: var(--card2);
  border-radius: 8px;
}

.dim button {
  border: 0;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  line-height: 1.6;
  padding: 3px 10px;
  border-radius: 6px;
  cursor: pointer;
}

.dim button:hover {
  color: var(--fg);
}

.dim button.on {
  background: var(--card);
  color: var(--fg);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.08);
}

.stats {
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 12px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.stats b {
  color: var(--fg);
  font-weight: 600;
}

.plot {
  position: relative;
}

.canvas {
  width: 100%;
  height: 210px;
}

.overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 13px;
  color: var(--muted);
  pointer-events: none;
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 4px;
  margin-top: 6px;
}

.lg {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 2px 6px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.lg:hover {
  background: var(--hover);
  border-color: var(--line);
}

.lg.off {
  opacity: 0.5;
}

.lg.off .sw {
  background: var(--line) !important;
}

.lg-name {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lg b {
  color: var(--fg);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.lg.off b {
  color: var(--muted);
}

.sw {
  width: 9px;
  height: 9px;
  border-radius: 2px;
  flex: none;
}

.reset {
  color: var(--accent);
}
</style>
