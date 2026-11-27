<script setup lang="ts">
/**
 * 概览页：**token 记用量，积分只读官方**。
 *
 * ## 结构（自上而下）
 *
 * 1. **五张指标卡**：积分总量 / 已用积分 / 已用 Token / 缓存命中 / 请求健康
 * 2. **近 14 天用量**（ECharts，可切维度与指标）
 * 3. **左右两栏**：左边积分按账号、右边 token 按账号
 * 4. **最近请求**
 *
 * ## 两条口径的基本规则
 *
 * - **积分**只读官方（各通道 `creditsOf()`）。各家的单位和重置规则都不同（前三家是
 *   总额度制，Loomy 是每日重置制），所以卡片上的「积分总量」必须写明含哪几个通道。
 * - **token** 是上游在响应 `usage` 帧里报的数，网关只记账汇总。它是唯一能跨通道
 *   相加的用量口径。
 *
 * ## 不能显示 0 的地方
 *
 * Qoder 的 token（`reportsTokens: false`）、拉不到的余额/已用、Loomy 的总额——
 * 一律显示 `—`。「统计不到」和「确实是 0」是两个不同的结论，用 0 会让人得出错误判断。
 */
import { computed, ref } from 'vue';

import { useRouter } from 'vue-router';

import { getAccounts, type ChannelCapability } from '@/api/accounts';
import { getChannels, looksOf } from '@/api/channels';
import { getUsage, type UsageRecord } from '@/api/usage';
import { useAsync } from '@/composables/useAsync';
import { fmtClock, fmtCny, fmtDuration, fmtNum, fmtRatio, fmtTokens } from '@/utils/format';
import { shouldWarnUncached, worstUncachedAccount } from '@/utils/uncached';
import CardPanel from '@/components/CardPanel.vue';
import ChannelIcon from '@/components/ChannelIcon.vue';
import MetricCard from '@/components/MetricCard.vue';
import RequestStatusBadge from '@/components/RequestStatusBadge.vue';
import TrendChart from '@/components/TrendChart.vue';

const accountsState = useAsync(getAccounts);
const usageState = useAsync(getUsage);
const channelsState = useAsync(getChannels);

const router = useRouter();

/**
 * 点趋势图上的某根柱子 → 进那一天的 24 小时视图。
 *
 * 概览页这里**不内嵌**单日视图：一页里两个时间粒度会让人分不清「这个数字是哪一段」，
 * 而且地址分享不出去。跳转到独立路由，能刷新、能前进后退。
 */
function openDay(date: string): void {
  void router.push({ name: 'day', params: { date } });
}

/**
 * 近 14 天图的口径。概览页要能在 通道/模型/账号 之间切换，所以做成受控状态，
 * 交给 `TrendChart` 的 `v-model:dim`——组件里点「按模型」会 `emit('update:dim')`，
 * 父组件不接这个事件的话，`dim="channel"` 永远钉死，按钮点了图也不变。
 */
const trendDim = ref<'channel' | 'model' | 'account'>('channel');

const accounts = computed(() => accountsState.data.value?.accounts ?? []);
const channelCaps = computed(() => accountsState.data.value?.channels ?? []);
const summary = computed(() => usageState.data.value);
const today = computed(() => summary.value?.today);
const daily = computed(() => summary.value?.daily ?? []);

/** 通道外观（图标 / 字母）按 id 索引。 */
const appearance = computed(() => looksOf(channelsState.data.value?.channels));

/* ------------------------------ 账号行 ------------------------------ */

/**
 * 一行一个账号，带上它的通道信息。左右两栏共用这一份。
 *
 * 不按通道分组：两栏都是「一行一个账号」，分组会白白占掉两倍行高，而通道名放在
 * 行内（图标的 `alt` 与 title）已经够读。
 */
const rows = computed(() =>
  accounts.value.map((account) => {
    const channel: ChannelCapability | undefined = channelCaps.value.find((c) => c.id === account.channelId);
    return {
      account,
      channelLabel: channel?.label ?? account.channelId,
      look: appearance.value(account.channelId, channel?.label ?? account.channelId),
      /** 上游会不会报 token。`false` 时 token 那一栏要显示 `—`。 */
      known: channel?.reportsTokens !== false,
    };
  }),
);

/* ------------------------------ 指标卡 ------------------------------ */

/**
 * **积分总量 = Σ「剩余」**，不是 Σ「总额度」。
 *
 * 用户打开概览页想知道的是「我手头现在有多少积分可用」，而不是「历史上总共给过
 * 多少额度」。所以总量 = Σ `totalRemain`，**包含 Loomy**——它虽然没有「总额度」
 * 概念（每天重置 5000、不用作废），但有「剩余」（当天还没用完的积分），加进去合理。
 *
 * 早先这里算的是「有 limitTotal 的账号的 limit 之和」，把 Loomy 整个排除了，而且
 * 那个语义本身就偏——wb-1 的 4937 早用掉了，显示出来毫无参考价值。
 *
 * 「已用」不再从 `usedTotal` 汇总：那是各通道**官方口径**的累计/当日消耗，时间窗
 * 各家不同（有的按日、有的按周期），加在一起没有意义。概览上用**账本**口径的
 * 「今天 / 近 30 天」（`today.credits` / `totals.credits`），口径统一。
 */
const creditTotal = computed(() =>
  rows.value.reduce((sum, r) => sum + (typeof r.account.totalRemain === 'number' ? r.account.totalRemain : 0), 0),
);

/**
 * 缓存命中率 = **排除「不报缓存的通道」之后**的实测加权率（`today.cacheHit.rate`）。
 *
 * 这里**不能**自己拿 `cachedTokens / promptTokens` 算：Trae 从不报缓存，那 7851 万输入
 * 会把率从 99% 拖到 84%。服务端已经按「其他通道的实测平均」把 Trae 折算掉了，
 * 两边口径必须一致，否则卡片和费用脚注会各说一套。
 */
const cacheHit = computed(() => fmtRatio(today.value?.cacheHit?.rate));

/**
 * 「已用积分（今日）」该显示什么。
 *
 * Trae 和 WorkBuddy **只报 token、不报单次积分**，所以它们的 `credit` 在账本里恒为 NULL，
 * 汇总出来必然是 0。显示 0 会被读成「用了但没花钱」——事实是「这个通道不提供这个数」。
 *
 * 判定依据是后端给的 `todayCreditsMissing`（今天有请求但全无 credit 的通道），
 * **不是前端猜**：有值就说明至少部分通道报得了，那时 0 是真的 0。
 */
const todayCredits = computed(() => {
  const missing = summary.value?.todayCreditsMissing ?? [];
  if (missing.length > 0) return '—';
  return fmtNum(today.value?.credits);
});

/** 副行说明「为什么是 —」。没有缺失时留空。 */
const todayCreditsNote = computed(() => {
  const missing = summary.value?.todayCreditsMissing ?? [];
  if (missing.length === 0) return '';
  return `${missing.join('/')} 不报单次积分`;
});

/**
 * 卡片副行：不声不响换口径是不行的，把「不含谁、按多少推算」写出来。
 *
 * 例：`不含 trae（按 99.0% 推算）`——读者一眼知道 99.0% 这个数是怎么来的。
 */
const cacheHitExcluded = computed(() => {
  const providers = today.value?.cacheHit?.estimated?.providers ?? [];
  if (providers.length === 0) return '';
  const prompt = today.value?.cacheHit?.estimated?.promptTokens ?? 0;
  if (prompt <= 0) return '';
  return `不含 ${providers.join('/')}（按 ${fmtRatio(today.value?.cacheHit?.estimated?.rate)} 推算）`;
});

/**
 * 按 DeepSeek 官方价目折合的费用（见 `shared/deepseek-pricing.ts`）。
 *
 * **它不是账单**：这些 token 花在 WorkBuddy/Trae/Qoder/Loomy 上，不走 DeepSeek 的 API。
 * 放在这里是因为「2 亿 token」这个数字本身没有尺度感——折成钱之后，用户能立刻判断
 * 「今天用得算多还是少」。
 *
 * 后端**逐条记录按各自时间戳**分峰谷计价后汇总（官方高峰价是空闲价的 2 倍），
 * 前端只管显示：`peakCny` / `offPeakCny` 已经拆好，不需要再判断时间。
 */
const cost = computed(() => today.value?.cost ?? null);

/**
 * 请求健康。
 *
 * **成功率排除 499**：客户端主动断开不是故障。`interrupted` 单独列出来——
 * 它不是错误，但次数偏高值得看见。
 */
const health = computed(() => {
  const counts = today.value?.statusCounts ?? {};
  const total = today.value?.requests ?? 0;
  const interrupted = counts['499'] ?? 0;
  const ok = counts['200'] ?? 0;
  // 分母去掉中断：那部分是「调用方不想要这个回答了」，不代表服务不出活。
  const effective = total - interrupted;
  return {
    interrupted,
    effective,
    failed: effective - ok,
    rate: effective > 0 ? `${((ok / effective) * 100).toFixed(1)}%` : '—',
    median: today.value?.medianDurationMs ?? null,
  };
});

/* ------------------------------ Token 用量 ------------------------------ */

/**
 * 总量类数字（`totals` / `byModel` / `byAccount`）覆盖的时间窗，由网关给。
 *
 * 用 `window.days` 拼文案，**不在这里写死 30**：网关把窗口从 30 天改成别的值、
 * 而页面还写着「累计」，那个错误没有任何报错，只会让人以为数字变少了。
 */
const windowLabel = computed(() => (summary.value?.window ? `近 ${summary.value.window.days} 天` : '近期'));

/**
 * 「今天有多少输入是全价算的」——判断逻辑在 `utils/uncached.ts`，那里能单测。
 *
 * 这里只负责取数和拼文案。**按账号判断，不用全账号合计**：同一天 lo-1 命中 1.3%、
 * wb-1 命中 99.8%，合计只有 1.1% 未命中，异常会被稀释掉（详见那个文件的注释）。
 */
const uncached = computed(() => worstUncachedAccount(summary.value?.todayByAccount));

/** 未命中占比够高才提示，否则日常小请求会一直亮着。 */
const uncachedLabel = computed(() => {
  const u = uncached.value;
  if (!shouldWarnUncached(u)) return '';
  return `· ${u.account} 全价 ${fmtTokens(u.tokens)}`;
});

const uncachedHint = computed(() => {
  const u = uncached.value;
  if (!u) return '';
  const pct = (u.ratio * 100).toFixed(0);
  return `${u.account} 今天有 ${fmtTokens(u.tokens)} 输入 token 未命中缓存（占 ${pct}%），这部分按全价计费。缓存是前缀缓存，大段新内容一次性进来时会整段全价。`;
});

/**
 * 按今日 token 降序——「谁在花」是这一栏要回答的问题。
 *
 * 账本里没有的账号也要出现（今日 0）：刚建的号还没用过，它应该在列表里，
 * 而不是消失。**但上游根本不报 token 的通道例外**，那种显示 `—`。
 */
const tokenRows = computed(() => {
  const byAccount = new Map<string, { today: number; total: number }>();
  for (const row of summary.value?.todayByAccount ?? []) byAccount.set(row.account, { today: row.tokens, total: 0 });
  for (const row of summary.value?.byAccount ?? []) {
    const hit = byAccount.get(row.account) ?? { today: 0, total: 0 };
    hit.total = row.tokens;
    byAccount.set(row.account, hit);
  }
  return rows.value
    .map((r) => {
      const hit = byAccount.get(r.account.id);
      return { ...r, today: hit?.today ?? 0, total: hit?.total ?? 0 };
    })
    .sort((a, b) => b.today - a.today);
});

/** 合计只算「上游会报 token」的账号；不报的通道在 note 里点名。 */
const tokenSum = computed(() => {
  const covered = tokenRows.value.filter((r) => r.known);
  return {
    today: covered.reduce((s, r) => s + r.today, 0),
    total: covered.reduce((s, r) => s + r.total, 0),
    missing: [...new Set(tokenRows.value.filter((r) => !r.known).map((r) => r.channelLabel))],
  };
});

/* ------------------------------ 最近请求 ------------------------------ */

/**
 * 最近请求：**成功和非成功混着取**，各占一半。
 *
 * 直接取账本前 8 条会出问题：实测某时刻账本里全是 499（一个长会话在陆续断开重连），
 * 整张表全是「中断」——用户看不到任何成功案例，也判断不出「到底能不能用」。
 *
 * 服务端的 `recent` 已经是「成功 10 条 + 非成功 10 条」混排好的（见 `ledger.ts`），
 * 这里只需再各取 4 条并保证顺序。
 */
const recent = computed(() => {
  const all = summary.value?.recent ?? [];
  const ok = all.filter((r) => r.status === 200).slice(0, 4);
  const bad = all.filter((r) => r.status !== 200).slice(0, 4);
  return [...ok, ...bad].sort((a, b) => b.ts - a.ts).slice(0, 8);
});

/** 这一行有没有 token 数据——`null` 和「0」要分开显示。 */
function hasTokens(record: UsageRecord): boolean {
  return typeof record.promptTokens === 'number' || typeof record.completionTokens === 'number';
}

/* ------------------------------ 页面级 ------------------------------ */

const notReady = computed(() => accounts.value.filter((a) => a.status !== 'ready'));
const loading = computed(() => accountsState.loading.value || usageState.loading.value);

/**
 * `channelsState` 也算进错误：图标拿不到时页面看着只是「少了几个图标」，
 * 用户不会想到去查网络。
 */
const error = computed(
  () => accountsState.error.value || usageState.error.value || channelsState.error.value,
);

function refresh(): void {
  void accountsState.refresh();
  void usageState.refresh();
  void channelsState.refresh();
}
</script>

<template>
  <div>
    <p v-if="error" class="alert bad">{{ error }}</p>

    <!-- 异常账号：只在真有问题时出现，不占常驻版面。 -->
    <div v-for="a in notReady" :key="a.id" class="alert" :class="a.status === 'invalid' ? 'bad' : 'warn'">
      <b>{{ a.channelLabel }}</b> · {{ a.id }} {{ a.label }} —
      {{ a.status === 'invalid' ? '凭据已失效，去账号页重新登录' : '已停用' }}
      <template v-if="a.statusMessage">：{{ a.statusMessage }}</template>
    </div>

    <!-- ============================ 五张指标卡 ============================ -->
    <div class="metrics">
      <MetricCard label="积分总量" :value="fmtNum(creditTotal)">
        <template #note>所有账号剩余积分合计</template>
      </MetricCard>

      <MetricCard label="已用积分（今日）" :value="todayCredits">
        <template #note>
          <span v-if="todayCreditsNote">{{ todayCreditsNote }}</span>
          <template v-else>
            {{ windowLabel }} {{ fmtNum(summary?.totals?.credits) }}
            <span v-if="uncachedLabel" class="uncached" :title="uncachedHint">{{ uncachedLabel }}</span>
          </template>
        </template>
      </MetricCard>

      <MetricCard label="已用 Token（今日）" :value="fmtTokens(today?.tokens)">
        <template #note>
          {{ windowLabel }} {{ fmtTokens(summary?.totals?.tokens) }}
          <template v-if="tokenSum.missing.length">· 不含 {{ tokenSum.missing.join('、') }}</template>
        </template>
      </MetricCard>

      <!--
        折合费用单开一张卡：塞在 token 卡里会把那张卡撑得比其他卡高，一排看过去不齐
        （实测过：五张卡里有三张被拉高，视觉上是断的）。
      -->
      <MetricCard label="折合DS费用（今日）" :value="fmtCny(cost?.cny)">
        <template #note>
          <template v-if="cost">
            高峰 {{ fmtCny(cost.peakCny) }} · 空闲 {{ fmtCny(cost.offPeakCny) }}
          </template>
          <template v-else>价目表里没有对应模型</template>
        </template>
      </MetricCard>

      <MetricCard label="缓存命中（今日）" :value="cacheHit">
        <template #note>
          <template v-if="cacheHitExcluded">{{ cacheHitExcluded }} · </template>
          省下 {{ fmtTokens(today?.cacheHit?.effectiveCachedTokens) }}
        </template>
      </MetricCard>

      <MetricCard label="请求健康（今日）" :value="health.rate">
        <template #note>
          有效 {{ fmtNum(health.effective, 0) }} 次
          <template v-if="health.interrupted">· 中断 {{ fmtNum(health.interrupted, 0) }}</template>
          <template v-if="health.median !== null">· 中位 {{ fmtDuration(health.median) }}</template>
        </template>
      </MetricCard>
    </div>

    <!-- ============================ 近 14 天 ============================ -->
    <CardPanel title="近 14 天用量">
      <template #actions>
        <button type="button" class="btn ghost sm" :disabled="loading" @click="refresh">
          {{ loading ? '读取中…' : '刷新' }}
        </button>
      </template>
      <TrendChart
        v-model:dim="trendDim"
        :daily="daily"
        :channels="channelsState.data.value?.channels ?? []"
        :loading="usageState.loading.value"
        @select="openDay"
      />
    </CardPanel>

    <!-- ==================== 左右两栏：积分 / Token ==================== -->
    <div class="pair">
      <CardPanel title="积分（按账号）" flush>
        <template #actions>
          <span class="dim">官方口径</span>
        </template>
        <table class="table">
          <thead>
            <tr>
              <th>账号</th>
              <th class="num">剩余</th>
              <th class="num">已用</th>
              <th class="num">总额</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.account.id">
              <td class="who">
                <ChannelIcon
                  :icon="row.look.icon"
                  :letter="row.look.letter"
                  :size="14"
                  :alt="row.channelLabel"
                />
                <router-link :to="`/accounts/${encodeURIComponent(row.account.id)}`" class="mono">{{ row.account.id }}</router-link>
                <span class="alabel" :title="row.channelLabel">{{ row.account.label }}</span>
              </td>
              <td class="num">{{ typeof row.account.totalRemain === 'number' ? fmtNum(row.account.totalRemain) : '—' }}</td>
              <td class="num">
                {{ typeof row.account.usedTotal === 'number' ? fmtNum(row.account.usedTotal) : '—' }}
              </td>
              <td class="num">{{ typeof row.account.limitTotal === 'number' ? fmtNum(row.account.limitTotal) : '—' }}</td>
            </tr>
            <tr v-if="rows.length === 0"><td colspan="4" class="empty">还没有账号。</td></tr>
          </tbody>
        </table>
        <p class="foot">
          各通道单位与重置规则不同，<b>不可相加</b>。
        </p>
      </CardPanel>

      <CardPanel title="Token 用量（按账号）" flush>
        <template #actions>
          <span class="dim">网关账本</span>
        </template>
        <table class="table">
          <thead>
            <tr>
              <th>账号</th>
              <th class="num">今日</th>
              <th class="num">{{ windowLabel }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in tokenRows" :key="row.account.id">
              <td class="who">
                <ChannelIcon
                  :icon="row.look.icon"
                  :letter="row.look.letter"
                  :size="14"
                  :alt="row.channelLabel"
                />
                <router-link :to="`/accounts/${encodeURIComponent(row.account.id)}/usage`" class="mono">{{ row.account.id }}</router-link>
                <span class="alabel" :title="row.channelLabel">{{ row.account.label }}</span>
              </td>
              <!-- 上游不报 token 的通道显示 —：0 会被读成「用过但没消耗」 -->
              <td class="num" :title="row.known ? undefined : '该通道上游不提供 token 用量'">
                {{ row.known ? fmtTokens(row.today) : '—' }}
              </td>
              <td class="num" :title="row.known ? undefined : '该通道上游不提供 token 用量'">
                {{ row.known ? fmtTokens(row.total) : '—' }}
              </td>
            </tr>
            <tr v-if="tokenRows.length === 0"><td colspan="3" class="empty">还没有账号。</td></tr>
          </tbody>
          <tfoot v-if="tokenRows.length > 0">
            <tr>
              <td>
                合计
                <span v-if="tokenSum.missing.length" class="dim">（不含 {{ tokenSum.missing.join('、') }}）</span>
              </td>
              <td class="num">{{ fmtTokens(tokenSum.today) }}</td>
              <td class="num">{{ fmtTokens(tokenSum.total) }}</td>
            </tr>
          </tfoot>
        </table>
        <p class="foot">
          token 是上游在响应 <code>usage</code> 帧里报的数，网关只记账汇总、不自己数。
          它可以跨通道相加。
        </p>
      </CardPanel>
    </div>

    <!-- ============================ 最近请求 ============================ -->
    <CardPanel title="最近请求" flush>
      <template #actions>
        <span class="dim">最近 8 条</span>
      </template>
      <table class="table">
        <thead>
          <tr>
            <th>时间</th>
            <th>账号</th>
            <th>模型</th>
            <th class="num">输入</th>
            <th class="num">缓存</th>
            <th class="num">输出</th>
            <th class="num">耗时</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, i) in recent" :key="i">
            <td class="mono">{{ fmtClock(r.ts) }}</td>
            <td>{{ r.account ?? '—' }}</td>
            <td class="mono ellipsis" :title="r.model ?? undefined">{{ r.model ?? '—' }}</td>
            <!-- 没有 usage 的行（429/402 这类没打到上游的）显示 —，不是 0 -->
            <td class="num">{{ hasTokens(r) ? fmtTokens(r.promptTokens) : '—' }}</td>
            <td class="num">{{ typeof r.cachedTokens === 'number' ? fmtTokens(r.cachedTokens) : '—' }}</td>
            <td class="num">{{ hasTokens(r) ? fmtTokens(r.completionTokens) : '—' }}</td>
            <td class="num">{{ fmtDuration(r.durationMs) }}</td>
            <td><RequestStatusBadge :status="r.status" /></td>
          </tr>
          <tr v-if="recent.length === 0">
            <td colspan="8" class="empty">还没有请求记录。</td>
          </tr>
        </tbody>
      </table>
      <p class="foot">
        成功率<b>排除 499</b>（客户端主动断开，不是故障）；缓存命中率 = 命中的输入量 ÷ 输入总量，
        缓存是输入的子集、不是增量。
      </p>
    </CardPanel>

    <p class="foot">
      <b>折合费用</b>是按 DeepSeek 官方价目（元/百万 token）折算的<b>参照值，不是账单</b>——
      这些 token 花在 WorkBuddy / Trae / Qoder / Loomy 上，不走 DeepSeek 的 API。
      按每条记录自己的时间分峰谷计价：北京时间工作日 <code>9:00-12:00</code>、
      <code>14:00-18:00</code> 为高峰，其余（含周末）为空闲，空闲价是高峰的一半。
      法定节假日未单独处理。
      <template v-if="(cost?.assumedCachedTokens ?? 0) > 0">
        <br />
        其中 <b>{{ fmtTokens(cost?.assumedCachedTokens) }}</b> 缓存命中是<b>推算</b>的：有通道不报缓存明细
        （实测它自己的客户端也只拿到 0），按<b>其他通道同期的实测平均命中率
        {{ fmtRatio(today?.cacheHit?.estimated?.rate) }}</b> 折算。<b>除这部分以外都是上游实测值。</b>
      </template>
    </p>
  </div>
</template>

<style scoped>
/* 六张指标卡。1280px 下挤 6 张会太小，`minmax(150px)` 让它在窄屏自动折成两行。 */
.metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

/* 「全价 X」：提示这部分输入没有命中缓存。用警示色而不是错误色——它是成本提示，不是故障。 */
.uncached {
  margin-left: 4px;
  color: var(--warn, #b45309);
  cursor: help;
}

/* 左右两栏。两栏各要 ~400px 才够读，窄屏就落成上下两张。 */
.pair {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
  gap: 16px;
  align-items: start;
}

/* 账号单元格：图标 + id + 名字。名字过长要能截断，不把数字挤走。 */
.who {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.alabel {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--muted);
  font-size: 12px;
}

tfoot td {
  border-top: 1px solid var(--line);
  font-weight: 600;
}

.foot {
  margin: 0;
  padding: 8px 12px 10px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.8;
}
</style>
