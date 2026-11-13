<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { claimCheckin, getAccount, getAccountCheckin, getAccountCredits } from '@/api/account-detail';
import { getAccountCatalog } from '@/api/models';
import { getAccountUsage } from '@/api/usage';
import { useAsync } from '@/composables/useAsync';
import { useAccountActions } from '@/composables/useAccountActions';
import { useFlash } from '@/composables/useFlash';
import { upstreamIdentity } from '@/utils/account';
import { fmtAgo, fmtDuration, fmtNum, fmtTime, fmtTokens } from '@/utils/format';
import CardPanel from '@/components/CardPanel.vue';
import CheckinBadge from '@/components/CheckinBadge.vue';
import RequestStatusBadge from '@/components/RequestStatusBadge.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import TrendChart from '@/components/TrendChart.vue';
import { errorText } from '@/utils/error';

const route = useRoute();
const router = useRouter();

const id = computed(() => String(route.params.id ?? ''));

const tab = computed<'overview' | 'usage' | 'models'>(() => {
  if (route.path.endsWith('/usage')) return 'usage';
  if (route.path.endsWith('/models')) return 'models';
  return 'overview';
});

const detail = useAsync(() => getAccount(id.value));
const credits = useAsync(() => getAccountCredits(id.value));
const usage = useAsync(() => getAccountUsage(id.value));
const checkin = useAsync(() => getAccountCheckin(id.value));
const catalog = useAsync(() => getAccountCatalog(id.value));

const account = computed(() => detail.data.value?.account);
const channel = computed(() => detail.data.value?.channel);

function reload(): void {
  void detail.refresh();
  void credits.refresh();
  void usage.refresh();
  void checkin.refresh();
  void catalog.refresh();
}

watch(id, reload);

const { flash, say } = useFlash();

const { busy, verify, toggle } = useAccountActions({
  account: computed(() => (account.value ? { id: account.value.id, status: account.value.status } : null)),
  onChanged: reload,
  onSay: say,
});

async function claim(): Promise<void> {
  busy.value = true;
  try {
    const result = await claimCheckin(id.value);
    reload();
    const status = result.result?.status;
    const gained = result.result?.credits;
    say(
      status === 'checked'
        ?
          typeof gained === 'number'
          ? `签到成功：+${fmtNum(gained)} 积分`
          : '签到成功（上游没报这次拿了多少积分）'
        : status === 'already'
          ? '今天已经领过了，这次没有新积分'
          : `没领到：${result.result?.message || status || '未知原因'}`,
      status === 'checked' || status === 'already' ? 'ok' : 'bad',
    );
  } catch (error) {
    say(errorText(error), 'bad');
  } finally {
    busy.value = false;
  }
}

const credentialText = computed(() => {
  const source = account.value?.credentialSource;
  if (!source) return account.value?.hasCredential ? '已保存（来源未知）' : '没有凭据';
  return source === 'login' ? '已保存（登录获得）' : `已保存（${source}）`;
});

const tokenExpiryText = computed(() => {
  const iso = account.value?.tokenExpiresAt;
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  return fmtTime(ts);
});

const upstreamText = computed(() =>
  account.value ? upstreamIdentity(account.value.profile, account.value.label) : '',
);

const recent = computed(() => (usage.data.value?.recent ?? []).slice(0, 10));
const models = computed(() => catalog.data.value?.models ?? []);

const packages = computed(() => credits.data.value?.packages ?? []);
const showAllPackages = ref(false);

const activePackages = computed(() => packages.value.filter((pkg) => pkg.limit - pkg.used > 0));
const exhaustedCount = computed(() => packages.value.length - activePackages.value.length);

const visiblePackages = computed(() => {
  if (showAllPackages.value) return packages.value;
  return activePackages.value.slice(0, 6);
});

function humanError(text: string): string {
  if (/is not valid JSON|Unexpected token '</iu.test(text)) {
    return `上游返回的是 HTML 而不是 JSON（多半被重定向到登录页或风控页）。这个号的凭据可能已失效，先点「检测」验一下。原始报错：${text}`;
  }
  return text;
}

function hiddenByVisibility(modelId: string): boolean {
  const visible = catalog.data.value?.visible;
  if (!visible) return false;
  return !visible.includes(modelId);
}

const error = computed(
  () => detail.error.value || credits.error.value || usage.error.value || catalog.error.value,
);
</script>

<template>
  <div>
    <p v-if="error" class="alert bad">{{ error }}</p>

    <section class="card">
      <div class="body">
        <div class="ahead">
          <span class="aid">{{ account?.id ?? id }}</span>
          <span class="name">{{ account?.label }}</span>
          <StatusBadge
            v-if="account"
            :status="account.status"
            :cooldown-until="account.cooldownUntil"
            :title="account.statusMessage"
          />
          <span v-if="upstreamText" class="muted small">上游 {{ upstreamText }}</span>
          <span class="grow" />
          <span class="cell"><i>余额</i>{{ typeof credits.data.value?.totalRemain === 'number' ? fmtNum(credits.data.value.totalRemain) : '—' }}</span>
          <span class="cell"><i>今日</i>{{ fmtNum(usage.data.value?.today?.credits ?? 0) }}</span>
          <button
            type="button"
            class="btn sm"
            :disabled="busy || !channel?.canVerify || account?.status === 'disabled'"
            :title="account?.status === 'disabled' ? '停用的号先「启用」再检测——检测通过会把它改回就绪' : undefined"
            @click="verify"
          >
            检测
          </button>
          <button type="button" class="btn sm" :disabled="busy" @click="toggle">
            {{ account?.status === 'disabled' ? '启用' : '停用' }}
          </button>
        </div>

        <p v-if="flash" class="flash" :class="flash.tone">{{ flash.text }}</p>

        <div class="tabs" role="group" aria-label="账号视图">
          <button
            type="button"
            :aria-pressed="tab === 'overview'"
            :class="{ on: tab === 'overview' }"
            @click="router.push(`/accounts/${encodeURIComponent(id)}`)"
          >
            概览
          </button>
          <button
            type="button"
            :aria-pressed="tab === 'usage'"
            :class="{ on: tab === 'usage' }"
            @click="router.push(`/accounts/${encodeURIComponent(id)}/usage`)"
          >
            用量
          </button>
          <button
            type="button"
            :aria-pressed="tab === 'models'"
            :class="{ on: tab === 'models' }"
            @click="router.push(`/accounts/${encodeURIComponent(id)}/models`)"
          >
            模型
          </button>
        </div>
      </div>
    </section>

    <template v-if="tab === 'overview'">
      <div class="grid2">
        <CardPanel title="余额">
          <p v-if="credits.data.value?.error" class="err">{{ humanError(credits.data.value.error) }}</p>
          <template v-else>
            <p class="big">
              {{ typeof credits.data.value?.totalRemain === 'number' ? fmtNum(credits.data.value.totalRemain) : '—' }}
            </p>
            <table v-if="visiblePackages.length" class="table">
              <thead>
                <tr><th>额度包</th><th class="num">总量</th><th class="num">已用</th><th class="num">剩余</th><th>到期</th></tr>
              </thead>
              <tbody>
                <tr v-for="(pkg, i) in visiblePackages" :key="i">
                  <td>{{ pkg.name }}</td>
                  <td class="num">{{ fmtNum(pkg.limit) }}</td>
                  <td class="num">{{ fmtNum(pkg.used) }}</td>
                  <td class="num" :class="{ zero: pkg.limit - pkg.used <= 0 }">{{ fmtNum(pkg.limit - pkg.used) }}</td>
                  <td>{{ pkg.expireAt ? fmtTime(pkg.expireAt) : '—' }}</td>
                </tr>
              </tbody>
            </table>
            <p v-else class="muted small">这个通道没有额度包明细，只有一个总数。</p>

            <p v-if="packages.length > visiblePackages.length" class="muted small">
              共 {{ packages.length }} 个额度包<template v-if="exhaustedCount">，其中 {{ exhaustedCount }} 个已用完</template>。
              <button type="button" class="btn sm ghost" @click="showAllPackages = true">展开全部</button>
            </p>
            <p v-else-if="showAllPackages && packages.length > 6" class="muted small">
              <button type="button" class="btn sm ghost" @click="showAllPackages = false">只看还有剩余的</button>
            </p>
          </template>
        </CardPanel>

        <CardPanel title="签到">
          <div class="row">
            <CheckinBadge
              v-if="checkin.data.value?.last"
              :status="checkin.data.value.last.status"
              :title="checkin.data.value.last.message"
            />
            <span v-else class="muted small">今天还没有记录</span>
            <span class="grow" />
            <button type="button" class="btn sm" :disabled="busy || !checkin.data.value?.canClaim" @click="claim">
              手动领取
            </button>
          </div>
          <p v-if="checkin.data.value?.last?.credits" class="muted small">
            今天拿到 {{ fmtNum(checkin.data.value.last.credits) }} 积分<template v-if="checkin.data.value.last.streakDays">，连签 {{ checkin.data.value.last.streakDays }} 天</template>
          </p>
          <p v-if="checkin.data.value?.status" class="muted small">
            上游状态：{{ checkin.data.value.status.checkedIn ? '今天已签' : '今天没签' }}
            <template v-if="checkin.data.value.status.enable === false">（签到未开放）</template>
          </p>
          <p v-if="checkin.data.value?.error" class="err small">{{ checkin.data.value.error }}</p>

          <dl class="kv">
            <dt>凭据</dt><dd>{{ credentialText }}</dd>
            <template v-if="tokenExpiryText"><dt>令牌到期</dt><dd>{{ tokenExpiryText }}</dd></template>
            <template v-if="usage.data.value?.recent?.[0]?.ts">
              <dt>上次请求</dt><dd>{{ fmtAgo(usage.data.value.recent[0].ts) }}</dd>
            </template>
          </dl>
        </CardPanel>
      </div>

      <CardPanel title="通道">
        <dl class="kv">
          <dt>通道</dt><dd>{{ channel?.label }}（<code>{{ channel?.idPrefix }}</code>）</dd>
          <template v-for="(value, key) in channel?.identity ?? {}" :key="key">
            <dt>{{ key }}</dt><dd><code>{{ value }}</code></dd>
          </template>
        </dl>
      </CardPanel>

      <CardPanel title="最近请求" flush>
        <table class="table">
          <thead>
            <tr><th>时间</th><th>模型</th><th class="num">积分</th><th class="num">耗时</th><th>状态</th></tr>
          </thead>
          <tbody>
            <tr v-for="(row, i) in recent" :key="i">
              <td class="mono">{{ fmtTime(row.ts) }}</td>
              <td class="mono ellipsis">{{ row.model }}</td>
              <td class="num">{{ fmtNum(row.credit ?? 0) }}</td>
              <td class="num">{{ fmtDuration(row.durationMs) }}</td>
              <td><RequestStatusBadge :status="row.status" /></td>
            </tr>
            <tr v-if="recent.length === 0"><td colspan="5" class="empty">还没有请求。</td></tr>
          </tbody>
        </table>
      </CardPanel>
    </template>

    <template v-else-if="tab === 'usage'">
      <CardPanel title="近 14 天消耗">
        <TrendChart :daily="usage.data.value?.daily ?? []" :loading="usage.loading.value" dim="model" />
      </CardPanel>

      <CardPanel title="按模型" flush>
        <table class="table">
          <thead>
            <tr>
              <th>模型</th>
              <th class="num">请求</th>
              <th class="num">Token</th>
              <th class="num">输入</th>
              <th class="num">输出</th>
              <th class="num">每千 token 积分</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, i) in usage.data.value?.byModel ?? []" :key="i">
              <td class="mono">{{ row.model }}</td>
              <td class="num">{{ fmtNum(row.requests, 0) }}</td>
              <td class="num">{{ fmtTokens(row.tokens) }}</td>
              <td class="num">{{ fmtTokens(row.promptTokens) }}</td>
              <td class="num">{{ fmtTokens(row.completionTokens) }}</td>
              <td class="num">{{ row.creditsPerKToken ?? '—' }}</td>
            </tr>
            <tr v-if="(usage.data.value?.byModel ?? []).length === 0"><td colspan="6" class="empty">还没有记录。</td></tr>
          </tbody>
        </table>
      </CardPanel>
    </template>

    <template v-else>
      <CardPanel
        :title="`实际取到的模型（${models.length}）`"
        flush
      >
        <template #actions>
          <span class="muted small">
            {{ catalog.data.value?.label ?? '' }} · 不过可见性（这是上游实际给的）
          </span>
        </template>
        <p v-if="catalog.data.value?.error" class="err pad">{{ catalog.data.value.error }}</p>
        <table v-else class="table">
          <thead>
            <tr><th>模型 id</th><th>名称</th><th class="num">上下文</th><th class="num">最大输出</th><th>可见性</th></tr>
          </thead>
          <tbody>
            <tr v-for="model in models" :key="model.id">
              <td class="mono">{{ model.id }}</td>
              <td>{{ model.name || '—' }}</td>
              <td class="num">{{ model.context_length ? fmtNum(model.context_length, 0) : '—' }}</td>
              <td class="num">{{ model.max_output_tokens ? fmtNum(model.max_output_tokens, 0) : '—' }}</td>
              <td>
                <span v-if="!catalog.data.value?.listed" class="muted small">通道总闸关闭</span>
                <span v-else-if="hiddenByVisibility(model.id)" class="muted small">被隐藏</span>
                <span v-else class="ok small">可见</span>
              </td>
            </tr>
            <tr v-if="models.length === 0 && !catalog.loading.value"><td colspan="5" class="empty">取不到模型目录。</td></tr>
          </tbody>
        </table>
      </CardPanel>
    </template>
    <p class="foot">
      这一页用来排查：余额对不对、签没签到、上游实际给了哪些模型。
      <b>换设备号、上游退出、删除账号</b>在 <router-link to="/accounts">账号页</router-link>
      那一行的「更多」里——不可逆的动作不放在排查页。
    </p>
  </div>
</template>

<style scoped>
.ahead {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 13px;
}

.aid {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  font-weight: 600;
}

.name {
  color: var(--muted);
}

.cell {
  color: var(--muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.cell i {
  font-style: normal;
  opacity: 0.7;
  margin-right: 4px;
}

.tabs {
  display: inline-flex;
  gap: 2px;
  margin-top: 12px;
  padding: 2px;
  background: var(--card2);
  border-radius: 8px;
}

.tabs button {
  border: 0;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  padding: 4px 14px;
  border-radius: 6px;
  cursor: pointer;
}

.tabs button:hover {
  color: var(--fg);
}

.tabs button.on {
  background: var(--card);
  color: var(--fg);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.08);
}

.grid2 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 16px;
  align-items: start;
}

.grid2 :deep(.card) {
  margin-bottom: 0;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.num.zero {
  color: var(--muted);
}

.foot {
  margin: 4px 0 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.9;
}

.big {
  margin: 0 0 8px;
  font-size: 28px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}

.kv {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 14px;
  margin: 10px 0 0;
  font-size: 13px;
}

.kv dt {
  color: var(--muted);
  font-size: 12px;
}

.kv dd {
  margin: 0;
}

.flash {
  margin: 8px 0 0;
  font-size: 12px;
}

.flash.ok {
  color: var(--ok);
}

.flash.bad {
  color: var(--bad);
}

.ok {
  color: var(--ok);
}

.pad {
  padding: 12px 16px;
}

</style>
