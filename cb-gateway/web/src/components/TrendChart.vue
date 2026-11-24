<script setup lang="ts">
/**
 * 近 14 天用量（token）：堆叠柱状图，可按 **通道 / 模型 / 账号** 三种口径拆分，
 * 并可切换 **总 Token / 仅输出** 两个指标。
 *
 * ## 为什么主口径是 token
 *
 * token 是网关唯一亲眼看到、且**能跨通道相加**的量（积分各家的单位和重置规则都不同，
 * 加在一起没有意义，见 private/docs/v3/overview-redesign.md）。`credits` 仍然在桶里，但不再画。
 *
 * **为什么要「仅输出」这个切换**：输入和输出差三个数量级（实测某天 1.22 亿 vs 11.9 万），
 * 堆在同一根柱子上输出那一段细到看不见。默认看总量（回答「用了多少」），切过去才看得清
 * 生成量的趋势。
 *
 * ## 三种口径的数据从哪来
 *
 * 全部来自 `GET /api/usage` 的 `daily[]`——每一天已经带了 `byProvider` / `byModel` /
 * `byAccount` 三个子桶，所以切换口径**不发请求**，也不存在「切过去空白一下」。
 * 子桶的 key 分别是通道 id（`workbuddy`）、上游模型名（`deepseek-v4.1-flash`）、账号 id（`wb-1`）。
 *
 * 通道那一维显示 `WorkBuddy` 而不是 `workbuddy`：id 是内部寻址用的，给人看的是 `label`。
 * 这个映射来自 `GET /api/channels`，前端**不自带**一份通道名表（那正是 v2 被清掉的东西）。
 *
 * ## 图例为什么是 HTML 而不是 ECharts 的 legend
 *
 * 需要三件 ECharts legend 给不了或不好给的事：
 *
 * 1. 图例里带累计值（`legend.formatter` 只能改文字，做不出「名字 + 右对齐数字」）；
 * 2. 布局要能自由换行、贴着卡片底边，而不是占掉绘图区高度（`grid` 得反过来让位）；
 * 3. 「全部显示」这个复位入口。
 *
 * 隐藏某一类是**从 option 里删掉那个 series**，不是 `legend.selected`：删掉之后 tooltip、
 * 合计、峰值自动只算剩下的，不存在「图例、提示框、统计各算一套」。颜色按**全局名次**分配，
 * 所以隐藏再恢复不会换色。
 *
 * ## 与 v2 的图（`ui/charts.ts`）相比刻意改了几处
 *
 * | v2 | 这里 | 为什么 |
 * |---|---|---|
 * | `yAxis.axisLabel.show: false` | 显示刻度 | 没有刻度的图只能靠悬停读数，等于装饰 |
 * | x 轴只标首尾 | 标首尾 + 中间每隔几根 | 14 天里只有两个日期时，中间那段读不出是哪天 |
 * | 段数上限内**逐日**合并「其他」 | **按 14 天累计**合并 | 逐日合并会让同一个模型今天算「其他」、明天独立成段 |
 * | 色板写死 8 色 | 读 `--chart-1..8` token | 换主题不用改组件 |
 * | 悬停只列 `日期：key N 积分 / M 次` | 加占比、合计、星期几、今天标记 | 单看绝对值判断不了「今天是不是异常」 |
 *
 * ## 两个踩过的坑（别回退）
 *
 * 1. **容器宽度为 0 时 `echarts.init()` 会退到默认 100px**，之后柱子全挤在左边、控制台不报错。
 *    所以这里让 canvas **始终挂载**（空数据时用浮层盖住，而不是 `v-show` 隐藏），
 *    并且用 `ResizeObserver` 盯容器尺寸。
 * 2. **日期字符串不能直接喂给 `new Date()`**：`'2026-11-13'` 会被当成 UTC 零点，
 *    在 UTC+8 以东的时区会退到前一天。轴标签只做 `slice(5)`，要算星期几就用
 *    `new Date(y, m - 1, d)` 按**本地**年月日构造。
 */
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
/** 图上画哪个数：总量（输入 + 输出）还是只画输出。 */
type Metric = 'total' | 'completion';

const props = withDefaults(
  defineProps<{
    daily: DailyBucket[];
    /** 只为把通道 id 翻成显示名，缺了也不影响其它两维。 */
    channels?: ChannelAppearance[];
    loading?: boolean;
    dim?: Dim;
  }>(),
  { channels: () => [], loading: false, dim: 'channel' },
);

const emit = defineEmits<{ (e: 'update:dim', dim: Dim): void; (e: 'select', date: string): void }>();

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

/**
 * 画哪个指标：**组件内部的视图状态**，不走 prop/emit。
 *
 * `dim` 是父组件管的（详情页要固定成「按模型」，所以它得能指定）；`metric` 没有这种
 * 需求，纯粹是「这张图此刻给我看什么」。做成受控 prop 时，父组件忘了接
 * `update:metric`——点了没反应、也不报错，实测踩过一次。
 */
const metric = ref<Metric>('total');

/**
 * 从桶里按当前指标取一个数。
 *
 * 桶的形状是 `{ tokens, completionTokens, requests, credits }`；`tokens` 已经是
 * 输入 + 输出，所以这里**不需要再加**（加缓存或加推理都是重复计算，见 api/usage.ts 的注释）。
 */
function valueOf(bucket: { tokens?: number; completionTokens?: number } | undefined): number {
  const raw = metric.value === 'completion' ? bucket?.completionTokens : bucket?.tokens;
  return Number(raw) || 0;
}
const DIM_FIELD: Record<Dim, 'byProvider' | 'byModel' | 'byAccount'> = {
  channel: 'byProvider',
  model: 'byModel',
  account: 'byAccount',
};
/** 段数上限：通道/模型留 5+其他，账号留 7+其他（账号 id 短，能多放几个）。 */
const DIM_LIMIT: Record<Dim, number> = { channel: 6, model: 6, account: 8 };

/** 被合并的那一类用的 key。用不可能撞上真实 id 的字符串。 */
const OTHER = '\u0000other';

/* ------------------------------ 颜色 ------------------------------ */

const FALLBACK_PALETTE = ['#2f6df6', '#0f9d8a', '#e08a00', '#8b5cf6', '#e0447c', '#5a9e1e', '#0891b2', '#b45309'];
const FALLBACK_OTHER = '#a3a9b3';

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** 色板只读一次：一页里所有图共用同一套顺序，中途改 token 的场景不存在。 */
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

/* ------------------------------ 数据整理 ------------------------------ */

interface Series {
  key: string;
  label: string;
  color: string;
  /** 14 天累计（按当前指标），图例右侧那个数字。 */
  total: number;
  days: { value: number; requests: number }[];
}

/** 通道 id → 显示名。只在这一条路径上用到通道清单。 */
const channelLabels = computed(() => {
  const map = new Map<string, string>();
  for (const c of props.channels) map.set(c.id, c.label);
  return map;
});

/**
 * 归并用的 key。
 *
 * 模型维度按小写归并：账本里同时存在 `deepseek-v4.1-flash` 和 `DeepSeek-V4.1-Flash`，
 * 那是同一个上游模型的不同写法，不归并图例会并排列出两个几乎一样的条目，看着像 bug。
 * 归并只发生在这张图里，`/api/usage` 的原始形状不动。
 */
function groupKey(raw: string): string {
  return props.dim === 'model' ? raw.toLowerCase() : raw;
}

const prepared = computed(() => {
  const rows = Array.isArray(props.daily) ? props.daily : [];
  const dates = rows.map((row) => String(row?.date ?? ''));
  const field = DIM_FIELD[props.dim];

  // 1) 先按 14 天累计排名次。**排名在合并之前**：只有这样「谁进其他」在每一天才是同一批人。
  const totals = new Map<string, number>();
  /** 归并 key → 这个 key 下出现过哪些原始写法、各自累计多少（用来挑一个显示名）。 */
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

  /** 同一归并 key 下累计最大的写法当显示名；并列时取字典序小的，保证刷新不跳。 */
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
    // 颜色按名次固定，隐藏再恢复不会换色。
    color: key === OTHER ? otherColor() : colors[i % colors.length],
    total: 0,
    days: rows.map(() => ({ value: 0, requests: 0 })),
  }));
  const slot = new Map(keys.map((key, i) => [key, i] as const));

  // 2) 逐日填值。零值的段直接丢掉——堆叠图里它们只是看不见的 0 高度。
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

/** 被点掉的分类。存 key 而不是下标：换口径/刷新后下标会变。 */
const hidden = ref<Set<string>>(new Set());

const visible = computed(() => prepared.value.series.filter((s) => !hidden.value.has(s.key)));

/** 合计/峰值/有消耗天数都只算**当前可见**的分类，和图上看到的一致。 */
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

/* ------------------------------ 绘图 ------------------------------ */

const chartEl = ref<HTMLDivElement | null>(null);
const chart = shallowRef<echarts.ECharts | null>(null);

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 悬停标题：`2026-11-13 周五 · 今天`。 */
function dayTitle(index: number): string {
  const date = prepared.value.dates[index] ?? '';
  const parts = date.split('-').map(Number);
  const [y, m, d] = parts;
  const valid = parts.length === 3 && parts.every((n) => Number.isFinite(n));
  // 按本地年月日构造（见文件头「坑 2」）。只用来算星期几。
  const week = valid ? ` ${WEEKDAYS[new Date(y, m - 1, d).getDay()]}` : '';
  const today = index === prepared.value.dates.length - 1 ? ' · 今天' : '';
  return `${date}${week}${today}`;
}

/** 轴上的数字：按量级折成「万」/「亿」——token 的量级跨得很开，千分位读不出大小。 */
function fmtAxis(value: number): string {
  if (!Number.isFinite(value)) return '';
  if (Math.abs(value) >= 1e8) return `${Number((value / 1e8).toFixed(2))}亿`;
  if (Math.abs(value) >= 1e4) return `${Number((value / 1e4).toFixed(1))}万`;
  return fmtNum(value, 0);
}

/**
 * 横轴要标哪几根。**必须显式带最后一天**：早先用 `interval: 2`（每 3 个标一个），
 * 14 天里最后一个日期被跳过，图上写着「到 11-12」而数据到 11-13，看着像少了一天。
 */
function tickIndexes(count: number): Set<number> {
  if (count <= 2) return new Set(Array.from({ length: count }, (_, i) => i));
  const maxTicks = 6;
  const step = Math.max(1, Math.ceil((count - 1) / (maxTicks - 1)));
  const picked: number[] = [];
  for (let i = 0; i < count - 1; i += step) picked.push(i);
  const last = count - 1;
  // 和倒数第二个挤在一起就把那个去掉，否则 ECharts 会把两个标签叠着画。
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
      // 只给绘图区加底色，不给柱子描边——堆叠柱一旦描边，窄段会被吃掉。
      axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(37, 99, 235, 0.06)' } },
      backgroundColor: '#fff',
      borderColor: line,
      borderWidth: 1,
      padding: 0,
      // 窄屏时贴着容器，别飘到视口外。
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
            // 占比小于 1% 时不能写 `0%`——那会被读成「没花钱」，而它其实花了。
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
        // 只保留 `tickIndexes()` 选中的几根（这里不能用 `interval: n`，它会把最后一天漏掉）。
        interval: (index: number) => ticks.has(index),
        formatter: (value: string, index: number) =>
          index === count - 1 && count > 1 ? `{today|${value}}` : value,
        // 今天那一根用强调色 + 加粗，省得每次都要数「最右边是几号」。
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
      // 堆叠顺序 = series 顺序 = 名次顺序，于是累计最大的那一类永远在最底下。
      data: item.days.map((day) => day.value),
      itemStyle: { color: item.color },
      barMaxWidth: 26,
      emphasis: { focus: 'series' },
    })),
  };
}

/** 某一天所有可见分类之和。tooltip 的占比用它做分母。 */
function sumVisible(index: number): number {
  return visible.value.reduce((sum, item) => sum + (item.days[index]?.value ?? 0), 0);
}

function render() {
  if (!chartEl.value) return;
  if (!chart.value) {
    chart.value = echarts.init(chartEl.value, undefined, { renderer: 'canvas' });
    // 点柱子 → 把这根柱子对应的日期报给父组件（「进当天 24 小时」的入口）。
    //
    // **只认柱子本体**：ECharts 的 `click` 只在图形元素上触发，点空白/网格线不会走到
    // 这里，所以不用额外判 `params.componentType`——那反而会在以后加折线时把自己坑住。
    chart.value.on('click', (params: any) => {
      const index = Number(params?.dataIndex);
      const bucket = Number.isFinite(index) ? props.daily[index] : undefined;
      if (bucket?.date) emit('select', bucket.date);
    });
  }
  // `notMerge: true`：切换口径后 series 数量变了，合并会留下上一次的残影。
  chart.value.setOption(buildOption(), true);
  // 首次绘制时容器可能刚从 `display:none` 变过来（`init()` 量到 0 → 退到 100px），
  // 这里补一次对齐。**同步调是安全的**：不在 `ResizeObserver` 回调里，不会引发重排环。
  const width = chartEl.value.clientWidth ?? 0;
  if (width > 0 && width !== lastWidth) {
    lastWidth = width;
    chart.value.resize();
  }
}

/**
 * 尺寸变化统一交给 `ResizeObserver`。
 *
 * 实测踩过：容器处于 `display:none` 时 `echarts.init()` 量到宽度 0，ECharts 退回默认
 * 100px；等数据到了、`watch` 触发重绘时 DOM 的 `display` 还没翻过来，`resize()` 量到的
 * 仍是 0——柱子全挤在最左边 100px 里，而控制台没有任何报错。观察器与「数据先到还是
 * 布局先到」无关，才是稳的。
 */
let observer: ResizeObserver | null = null;
/**
 * 上次 resize 用的宽度。
 *
 * `resize()` 会重建整块 canvas 位图；宽度没变时反复调它是纯浪费。更要紧的是
 * **不能在 `ResizeObserver` 回调里同步 resize**——那会在同一次布局里写回尺寸，
 * Chrome 会报 `ResizeObserver loop completed with undelivered notifications`，
 * 极端情况下渲染进程卡死。所以统一丢进 `requestAnimationFrame` 并去重。
 */
let lastWidth = 0;
let rafId = 0;

function scheduleResize() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    const width = chartEl.value?.clientWidth ?? 0;
    if (width <= 0 || width === lastWidth) return;
    lastWidth = width;
    chart.value?.resize();
  });
}

function onWindowResize() {
  // 窗口缩放走同一条去重路径：它最终也是「宽度变了」。
  lastWidth = 0;
  scheduleResize();
}

onMounted(() => {
  render();
  lastWidth = chartEl.value?.clientWidth ?? 0;
  if (chartEl.value) {
    observer = new ResizeObserver(scheduleResize);
    observer.observe(chartEl.value);
  }
  window.addEventListener('resize', onWindowResize);
});

onBeforeUnmount(() => {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  window.removeEventListener('resize', onWindowResize);
  observer?.disconnect();
  observer = null;
  chart.value?.dispose();
  chart.value = null;
});

// 换口径时清掉隐藏状态：另一种口径下的 key 完全不同，留着只会让人看到一张空图。
watch(
  () => props.dim,
  () => {
    hidden.value = new Set();
  },
);

// `flush: 'post'` 保证 DOM 已更新（尺寸可量），再重绘。
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
      <!-- 指标切换：输入和输出差三个数量级，堆在一起输出看不见，所以要能单独看。 -->
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

/* iOS 那类「滑块式」分段控件：选中项是白底浮起，不是整块填充。
   整块填充会把「当前口径」变成页面上最重的一块颜色，而它只是个筛选器。 */
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

/* 空态/加载态盖在画布上，而不是把画布 `display:none`——后者会让 ECharts 量到 0 宽。 */
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

/* 隐藏时色块转灰，和「这一项不在图里」对上。 */
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
