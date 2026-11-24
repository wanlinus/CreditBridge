<script setup lang="ts">
/**
 * 单日用量：某一天按 24 小时拆开，指标可切「Token / 等效费用」。
 *
 * ## 为什么是独立路由而不是概览页里垫一块
 *
 * 概览页已经有「近 14 天」的趋势；把这 24 小时塞进去会让那一页同时有两个时间粒度，
 * 而且地址分享不出去。独立路由 `/day/2026-11-13` 能刷新、能前进后退、能贴给人看。
 *
 * ## 费用为什么不在前端算
 *
 * 价目表和峰谷规则在网关的 `shared/deepseek-pricing.ts`。前端复制一份会立刻变成两份
 * 事实：调价之后界面上的数和概览卡对不上，而且**不会有任何报错**。所以 `cost` 由
 * `/api/usage/hourly` 直接给，这里只负责格式化。
 *
 * ## 峰谷底色
 *
 * 柱子的深色版本 = 官方峰时段（工作日 9-12 / 14-18）。这不是装饰：切到「等效费用」时，
 * 峰时段的柱子会明显更高，那正是「为什么早上那批特别贵」的答案。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import * as echarts from 'echarts/core';
import { BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

import { getHourlyUsage, type HourlyBucket } from '@/api/usage';
import { useAsync } from '@/composables/useAsync';
import { fmtCny, fmtNum, fmtTokens } from '@/utils/format';
import CardPanel from '@/components/CardPanel.vue';

echarts.use([BarChart, GridComponent, TooltipComponent, CanvasRenderer]);

const route = useRoute();
const router = useRouter();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;

/** 路由里的日期；不合法就退回今天（地址栏写错不该白屏）。 */
const date = computed(() => {
  const raw = String(route.params.date ?? '');
  return DATE_RE.test(raw) ? raw : todayKey();
});

/** 右上角那个 `?account=wb-1`——账号详情页点柱子过来的。 */
const account = computed(() => {
  const raw = route.query.account;
  return typeof raw === 'string' && raw !== '' ? raw : null;
});

const state = useAsync(() => getHourlyUsage(date.value, { account: account.value }));

// 换日期 / 换账号都要重拉。
watch([date, account], () => void state.refresh());

/* ------------------------------ 日期导航 ------------------------------ */

function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** 在 `YYYY-MM-DD` 上加减天数，仍然按本地日历日算。 */
function shiftDate(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const next = new Date(y, m - 1, d);
  next.setDate(next.getDate() + days);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
}

const isToday = computed(() => date.value === todayKey());
const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const weekdayLabel = computed(() => (state.data.value ? WEEKDAY[state.data.value.weekday] : ''));

function go(days: number): void {
  const next = shiftDate(date.value, days);
  // 未来不让走：网关那边会回 400，前端提前挡住，省一次往返和一个错误提示。
  if (next > todayKey()) return;
  void router.push({ name: 'day', params: { date: next }, query: route.query });
}

function backToOverview(): void {
  void router.push({ name: 'overview' });
}

/* ------------------------------ 图表 ------------------------------ */

type Metric = 'token' | 'cost';
const metric = ref<Metric>('token');

const chartEl = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;

/** 当前指标下某一小时的值。 */
function valueOf(bucket: HourlyBucket): number {
  if (metric.value === 'cost') return Number(bucket.cost?.cny) || 0;
  return Number(bucket.tokens) || 0;
}

const HOUR_LABELS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));

function render(): void {
  if (!chartEl.value) return;
  if (!chart) {
    chart = echarts.init(chartEl.value);
  }
  const buckets = state.data.value?.hours ?? [];
  const peakColor = cssVar('--chart-1', '#2f6df6');
  const offPeakColor = cssVar('--chart-1-soft', '#a9c0fb');
  const muted = cssVar('--muted', '#8a919e');
  const line = cssVar('--line', '#e5e7eb');

  chart.setOption(
    {
      grid: { left: 8, right: 8, top: 16, bottom: 8, containLabel: true },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: any) => {
          const list = Array.isArray(params) ? params : [params];
          const bucket = buckets[list[0]?.dataIndex ?? 0];
          if (!bucket) return '';
          const rows = [
            `<b>${HOUR_LABELS[bucket.hour]}:00–${HOUR_LABELS[bucket.hour]}:59</b>${bucket.peak ? '（峰时）' : ''}`,
            `Token：${fmtTokens(bucket.tokens)}（输入 ${fmtTokens(bucket.promptTokens)} / 推算缓存 ${fmtTokens(bucket.cachedTokens)} / 输出 ${fmtTokens(bucket.completionTokens)}）`,
            `请求：${fmtNum(bucket.requests, 0)} 次`,
            `折合费用：${fmtCny(bucket.cost?.cny)}${bucket.peak ? '（高峰价）' : ''}`,
          ];
          return rows.join('<br/>');
        },
      },
      xAxis: {
        type: 'category',
        data: HOUR_LABELS,
        axisLine: { lineStyle: { color: line } },
        axisTick: { show: false },
        axisLabel: { color: muted, interval: 1, fontSize: 10 },
      },
      yAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: line } },
        axisLabel: {
          color: muted,
          fontSize: 10,
          formatter: (value: number) => (metric.value === 'cost' ? fmtCny(value) : fmtTokens(value)),
        },
      },
      series: [
        {
          type: 'bar',
          // 峰时段用实色、空闲用浅色（同一色相的两个明度）。
          //
          // 早先用的是「深蓝 vs 亮蓝」（#1d4ed8 vs #2f6df6），实测在真实屏幕上几乎分
          // 不出来——图例写着「深色 = 高峰」，看起来却像一种颜色。同色相拉开明度才认得出来。
          data: buckets.map((bucket) => ({
            value: valueOf(bucket),
            itemStyle: { color: bucket.peak ? peakColor : offPeakColor, borderRadius: [3, 3, 0, 0] },
          })),
          barMaxWidth: 28,
        },
      ],
    },
    { notMerge: true },
  );
}

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * 数据和指标变了就重画。
 *
 * 容器现在**常驻**（模板里不再用 `v-if` 摘掉它），所以 `chartEl` 从挂载那一刻起就有效，
 * 不再依赖「watcher 必须晚于 DOM 更新」这种时序假设。
 */
watch([() => state.data.value, metric], () => render());

/**
 * 容器宽度变化（侧边栏收起、窗口缩放）后 canvas 不会自己跟着变。
 *
 * **两条纪律，都是踩过的**：
 *   1. 不在 `ResizeObserver` 回调里**同步**调 `resize()`——那会在同一次布局里写回
 *      canvas 尺寸，触发重排，Chrome 会报 `ResizeObserver loop completed with undelivered
 *      notifications`，极端情况下渲染进程卡死/崩掉。丢进 `requestAnimationFrame` 里做。
 *   2. 宽度没变就不 resize：`resize()` 会重建整块 canvas 位图，反复调用是纯浪费。
 *
 * 早先还犯过一个更严重的：拿 ECharts 的 `finished` 事件驱动 `resize()`——`resize` 会再
 * 触发一次渲染、又发 `finished`，等于给自己喂事件，CPU 打满、Chrome 开一会儿就崩。
 */
let lastWidth = 0;
let rafId = 0;

function scheduleResize(): void {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    const width = chartEl.value?.clientWidth ?? 0;
    if (width <= 0 || width === lastWidth) return;
    lastWidth = width;
    chart?.resize();
  });
}

let observer: ResizeObserver | null = null;

onMounted(() => {
  // 挂载时就画一次（此时还没有数据，画出来的是 24 个空轴）——让「有图但还没数」和
  // 「图根本没挂上」在视觉上分得开。
  render();
  lastWidth = chartEl.value?.clientWidth ?? 0;
  if (chartEl.value) {
    observer = new ResizeObserver(scheduleResize);
    observer.observe(chartEl.value);
  }
});

onBeforeUnmount(() => {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  observer?.disconnect();
  observer = null;
  chart?.dispose();
  chart = null;
});

/* ------------------------------ 表格 ------------------------------ */

/** 表格只列**有记录的小时**还是全部 24 行？——全部。
 *
 * 「0 点到 7 点一条都没有」本身是信息（夜间没人用），只列有数的会让人以为那天只有
 * 十几个小时。24 行也不长。
 */
const rows = computed(() => state.data.value?.hours ?? []);
const totals = computed(() => state.data.value?.totals ?? null);
</script>

<template>
  <div>
    <p v-if="state.error.value" class="alert bad">{{ state.error.value }}</p>

    <!-- 顶部：日期 + 前后一天 + 指标切换 -->
    <div class="head">
      <div class="daynav">
        <button type="button" class="btn ghost" title="前一天" @click="go(-1)">‹</button>
        <b class="date">{{ date }}</b>
        <span v-if="weekdayLabel" class="dim">{{ weekdayLabel }}</span>
        <button type="button" class="btn ghost" :disabled="isToday" title="后一天" @click="go(1)">›</button>
        <button v-if="!isToday" type="button" class="btn ghost small" @click="go(9999)">回到今天</button>
        <span v-if="state.data.value?.isPeakDay === false" class="tag">周末 · 全天空闲价</span>
        <span v-if="account" class="tag">仅 {{ account }}</span>
      </div>
      <div class="switch">
        <button type="button" :class="['seg', { on: metric === 'token' }]" @click="metric = 'token'">Token</button>
        <button type="button" :class="['seg', { on: metric === 'cost' }]" @click="metric = 'cost'">等效费用</button>
      </div>
    </div>

    <CardPanel :title="`按小时（${metric === 'cost' ? '等效费用' : 'Token'}）`">
      <template #actions>
        <span class="dim">实色 = 高峰时段（工作日 9-12 / 14-18），浅色 = 空闲</span>
        <button type="button" class="btn ghost small" @click="state.refresh()">刷新</button>
      </template>
      <!--
        容器**永远存在**，加载态用一层覆盖文字，不用 v-if 把容器摘掉。

        这是踩过的坑：原来写成 `v-if="loading" 加载中 / v-else 图表容器`，于是首次挂载时
        `chartEl` 是 null，`echarts.init()` 拿到 null 直接 return——图永远不出现，控制台
        一声不响。当时靠 `watch` 的 `flush: 'post'` 兜住，但那个依赖很脆（默认 `pre` 就在
        DOM 更新前跑）。容器常驻之后，这个时序问题从根上不存在。
      -->
      <div class="chartbox">
        <div ref="chartEl" class="chart"></div>
        <div v-if="state.loading.value && !state.data.value" class="chart-mask">加载中…</div>
      </div>
    </CardPanel>

    <CardPanel title="全天明细" flush>
      <template #actions>
        <span class="dim">
          折合费用是按 DeepSeek 官方价目算的<b>参照值，不是账单</b>
          <template v-if="(totals?.assumedCachedTokens ?? 0) > 0">
            · 「推算缓存」= 上游报的原值 + Trae 按<b>这一天实测平均命中率</b>折算的部分
            （其中 <b>{{ fmtTokens(totals?.assumedCachedTokens) }}</b> 是折算的）
          </template>
        </span>
      </template>
      <table class="table">
        <thead>
          <tr>
            <th>时段</th>
            <th class="num">请求</th>
            <th class="num">输入</th>
            <th class="num">推算缓存</th>
            <th class="num">输出</th>
            <th class="num">折合费用</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.hour" :class="{ peak: row.peak && row.requests > 0 }">
            <td class="mono">
              {{ String(row.hour).padStart(2, '0') }}:00
              <span v-if="row.peak && row.requests > 0" class="peakdot" title="高峰时段">●</span>
            </td>
            <td class="num">{{ fmtNum(row.requests, 0) }}</td>
            <td class="num">{{ row.requests ? fmtTokens(row.promptTokens) : '—' }}</td>
            <td class="num">{{ row.requests ? fmtTokens(row.cachedTokens) : '—' }}</td>
            <td class="num">{{ row.requests ? fmtTokens(row.completionTokens) : '—' }}</td>
            <td class="num">{{ row.requests ? fmtCny(row.cost?.cny) : '—' }}</td>
          </tr>
        </tbody>
        <tfoot v-if="totals">
          <tr>
            <td>合计</td>
            <td class="num">{{ fmtNum(totals.requests, 0) }}</td>
            <td class="num">{{ fmtTokens(totals.promptTokens) }}</td>
            <td class="num">{{ fmtTokens(totals.cachedTokens) }}</td>
            <td class="num">{{ fmtTokens(totals.completionTokens) }}</td>
            <td class="num">{{ fmtCny(totals.cost?.cny) }}</td>
          </tr>
        </tfoot>
      </table>
    </CardPanel>

    <p class="foot">
      <button type="button" class="link" @click="backToOverview">← 回概览</button>
      <span v-if="totals && totals.cost" class="dim">
        高峰 {{ fmtCny(totals.cost.peakCny) }} · 空闲 {{ fmtCny(totals.cost.offPeakCny) }}
      </span>
    </p>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.daynav {
  display: flex;
  align-items: center;
  gap: 8px;
}

.date {
  font-size: 16px;
  font-variant-numeric: tabular-nums;
}

.tag {
  font-size: 12px;
  color: var(--muted);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 1px 8px;
}

.switch {
  display: flex;
  gap: 4px;
}

.seg {
  border: 1px solid var(--line);
  background: var(--card);
  color: var(--muted);
  border-radius: 6px;
  padding: 4px 12px;
  font-size: 13px;
  cursor: pointer;
}

.seg.on {
  color: var(--fg);
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}

.chart {
  width: 100%;
  height: 280px;
}

/* 加载态盖在图上面，而不是把容器摘掉——摘掉会让 `echarts.init()` 拿到 null。 */
.chartbox {
  position: relative;
}

.chart-mask {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  font-size: 13px;
  background: var(--card);
}

.peak td {
  background: color-mix(in srgb, var(--accent) 4%, transparent);
}

.peakdot {
  color: var(--accent);
  font-size: 9px;
  vertical-align: middle;
}

.foot {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
  font-size: 12px;
}

.link {
  border: 0;
  background: none;
  color: var(--accent);
  cursor: pointer;
  font-size: 12px;
  padding: 0;
}
</style>
