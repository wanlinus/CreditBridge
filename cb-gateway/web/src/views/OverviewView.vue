<script setup lang="ts">
import { computed } from 'vue';

import { getAccounts, type ChannelCapability } from '@/api/accounts';
import { getChannels, type ChannelAppearance } from '@/api/channels';
import { getUsage, type UsageRecord } from '@/api/usage';
import { useAsync } from '@/composables/useAsync';
import { fmtClock, fmtCny, fmtDuration, fmtNum, fmtPercent, fmtTokens } from '@/utils/format';
import CardPanel from '@/components/CardPanel.vue';
import ChannelIcon from '@/components/ChannelIcon.vue';
import MetricCard from '@/components/MetricCard.vue';
import RequestStatusBadge from '@/components/RequestStatusBadge.vue';
import TrendChart from '@/components/TrendChart.vue';

const accountsState = useAsync(getAccounts);
const usageState = useAsync(getUsage);
const channelsState = useAsync(getChannels);

const accounts = computed(() => accountsState.data.value?.accounts ?? []);
const channelCaps = computed(() => accountsState.data.value?.channels ?? []);
const summary = computed(() => usageState.data.value);
const today = computed(() => summary.value?.today);
const daily = computed(() => summary.value?.daily ?? []);

const appearance = computed(() => {
  const map = new Map<string, ChannelAppearance>();
  for (const c of channelsState.data.value?.channels ?? []) map.set(c.id, c);
  return map;
});

const rows = computed(() =>
  accounts.value.map((account) => {
    const channel: ChannelCapability | undefined = channelCaps.value.find((c) => c.id === account.channelId);
    return {
      account,
      channelLabel: channel?.label ?? account.channelId,
      look: appearance.value.get(account.channelId),
      known: channel?.reportsTokens !== false,
    };
  }),
);

const creditTotal = computed(() => {
  const remain = rows.value.reduce((sum, r) => sum + (typeof r.account.totalRemain === 'number' ? r.account.totalRemain : 0), 0);
  const used = rows.value.reduce((sum, r) => sum + (typeof r.account.usedTotal === 'number' ? r.account.usedTotal : 0), 0);
  return { remain, used };
});

const cacheHit = computed(() => fmtPercent(today.value?.cachedTokens, today.value?.promptTokens));

const cost = computed(() => today.value?.cost ?? null);

const health = computed(() => {
  const counts = today.value?.statusCounts ?? {};
  const total = today.value?.requests ?? 0;
  const interrupted = counts['499'] ?? 0;
  const ok = counts['200'] ?? 0;
  const effective = total - interrupted;
  return {
    interrupted,
    effective,
    failed: effective - ok,
    rate: effective > 0 ? `${((ok / effective) * 100).toFixed(1)}%` : '—',
    median: today.value?.medianDurationMs ?? null,
  };
});

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

const tokenSum = computed(() => {
  const covered = tokenRows.value.filter((r) => r.known);
  return {
    today: covered.reduce((s, r) => s + r.today, 0),
    total: covered.reduce((s, r) => s + r.total, 0),
    missing: [...new Set(tokenRows.value.filter((r) => !r.known).map((r) => r.channelLabel))],
  };
});

const recent = computed(() => {
  const all = summary.value?.recent ?? [];
  const ok = all.filter((r) => r.status === 200).slice(0, 4);
  const bad = all.filter((r) => r.status !== 200).slice(0, 4);
  return [...ok, ...bad].sort((a, b) => b.ts - a.ts).slice(0, 8);
});

function hasTokens(record: UsageRecord): boolean {
  return typeof record.promptTokens === 'number' || typeof record.completionTokens === 'number';
}

const notReady = computed(() => accounts.value.filter((a) => a.status !== 'ready'));
const loading = computed(() => accountsState.loading.value || usageState.loading.value);

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

    <div v-for="a in notReady" :key="a.id" class="alert" :class="a.status === 'invalid' ? 'bad' : 'warn'">
      <b>{{ a.channelLabel }}</b> · {{ a.id }} {{ a.label }} —
      {{ a.status === 'invalid' ? '凭据已失效，去账号页重新登录' : a.status === 'disabled' ? '已停用' : '限流中' }}
      <template v-if="a.status === 'cooldown' && a.cooldownUntil">（{{ fmtClock(a.cooldownUntil) }} 恢复）</template>
      <template v-if="a.statusMessage">：{{ a.statusMessage }}</template>
    </div>

    <div class="metrics">
      <MetricCard label="积分总量" :value="fmtNum(creditTotal.remain)">
        <template #note>所有账号剩余积分合计</template>
      </MetricCard>

      <MetricCard label="已用积分" :value="fmtNum(creditTotal.used)">
        <template #note>上游报的已用</template>
      </MetricCard>

      <MetricCard label="已用 Token（今日）" :value="fmtTokens(today?.tokens)">
        <template #note>
          累计 {{ fmtTokens(summary?.totals?.tokens) }}
          <template v-if="tokenSum.missing.length">· 不含 {{ tokenSum.missing.join('、') }}</template>
        </template>
      </MetricCard>

      <MetricCard label="折合DS费用（今日）" :value="fmtCny(cost?.cny)">
        <template #note>
          <template v-if="cost">
            高峰 {{ fmtCny(cost.peakCny) }} · 空闲 {{ fmtCny(cost.offPeakCny) }}
          </template>
          <template v-else>价目表里没有对应模型</template>
        </template>
      </MetricCard>

      <MetricCard label="缓存命中（今日）" :value="cacheHit">
        <template #note>省下 {{ fmtTokens(today?.cachedTokens) }}</template>
      </MetricCard>

      <MetricCard label="请求健康（今日）" :value="health.rate">
        <template #note>
          有效 {{ fmtNum(health.effective, 0) }} 次
          <template v-if="health.interrupted">· 中断 {{ fmtNum(health.interrupted, 0) }}</template>
          <template v-if="health.median !== null">· 中位 {{ fmtDuration(health.median) }}</template>
        </template>
      </MetricCard>
    </div>

    <CardPanel title="近 14 天用量">
      <template #actions>
        <button type="button" class="btn ghost sm" :disabled="loading" @click="refresh">
          {{ loading ? '读取中…' : '刷新' }}
        </button>
      </template>
      <TrendChart
        :daily="daily"
        :channels="channelsState.data.value?.channels ?? []"
        :loading="usageState.loading.value"
        dim="channel"
      />
    </CardPanel>

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
                  :icon="row.look?.icon ?? null"
                  :letter="row.look?.letter ?? row.channelLabel.slice(0, 1)"
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
              <th class="num">累计</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in tokenRows" :key="row.account.id">
              <td class="who">
                <ChannelIcon
                  :icon="row.look?.icon ?? null"
                  :letter="row.look?.letter ?? row.channelLabel.slice(0, 1)"
                  :size="14"
                  :alt="row.channelLabel"
                />
                <router-link :to="`/accounts/${encodeURIComponent(row.account.id)}/usage`" class="mono">{{ row.account.id }}</router-link>
                <span class="alabel" :title="row.channelLabel">{{ row.account.label }}</span>
              </td>
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
    </p>
  </div>
</template>

<style scoped>
.metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.pair {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
  gap: 16px;
  align-items: start;
}

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
