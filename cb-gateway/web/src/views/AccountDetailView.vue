<script setup lang="ts">
/**
 * 账号详情：**一个页面，三个 tab**（概览 / 用量 / 模型）。
 *
 * ## 为什么不拆成三个页面
 *
 * v2 是 `/accounts/<id>`、`/usage`、`/models` 三个独立页面，但它们回答的是同一个问题：
 * 「这个号怎么了」。排查时的动作是来回跳：「余额对不上 → 看用量 → 看它到底有哪些模型」。
 * 拆开之后每次跳转都要重新定位，而且账号头（id / 状态 / 余额）在三页各渲染一遍。
 *
 * 现在账号头常驻，tab 只换下半屏；tab 切换**改路由**（`/accounts/wb-1/usage`），
 * 所以深链接和后退键照常工作。
 *
 * ## 这一页只做「看」和轻动作
 *
 * 主操作只有三个：检测、停用/启用、手动签到。换设备号、上游退出、删除仍在账号页——
 * 详情页是排查的地方，不可逆操作不该出现在这里。
 */
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

/** tab 由**当前路径**决定，不是本地状态——这样刷新和后退都停在同一个 tab。 */
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

/**
 * 「按模型」那张表覆盖的时间窗，由网关给（`window.days`）。
 *
 * 用网关报的天数拼标题，**不写死**：窗口改了而标题没改，用户只会觉得数字莫名其妙变小。
 */
const usageWindowLabel = computed(() =>
  usage.data.value?.window ? `近 ${usage.data.value.window.days} 天` : '近期',
);

/**
 * 点这张图上的某根柱子 → 进那一天的 24 小时视图，**带上 `?account=`**。
 *
 * 不带账号的话，跳过去看到的是全网关的用量，和这张图的口径不是一个东西——那种
 * 「数字突然变大」的错不会报错，只会让人怀疑自己点错了。
 */
function openDay(date: string): void {
  void router.push({ name: 'day', params: { date }, query: { account: id.value } });
}

function reload(): void {
  void detail.refresh();
  void credits.refresh();
  void usage.refresh();
  void checkin.refresh();
  void catalog.refresh();
}

// 从 wb-1 跳到 wb-2（或前进后退）时，组件会被复用——必须重拉。
watch(id, reload);

const { flash, say } = useFlash();

// 检测 / 停用和账号列表共用一份实现（`useAccountActions`）。
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
        ? // 上游不一定报积分（WorkBuddy 的 `credit` 可能是 null）。说「+0 积分」是错的。
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

/** 凭据来源说人话。`login` 是走过一次授权，其它值原样显示——别吞掉未知来源。 */
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

/** 上游身份。和账号列表共用一份实现（`utils/account.ts`），避免两处漂移。 */
const upstreamText = computed(() =>
  account.value ? upstreamIdentity(account.value.profile, account.value.label) : '',
);

const recent = computed(() => (usage.data.value?.recent ?? []).slice(0, 10));
const models = computed(() => catalog.data.value?.models ?? []);

/**
 * 额度包列表的折叠。
 *
 * 实测：WorkBuddy 一个号有 **40 个**额度包，绝大多数是已经用完的历史包（`已用 == 总量`）。
 * 全列出来会把这一页变成一张几百行高的大表，而「还剩多少钱」被挤到第一屏之外——
 * 那正是来这一页要看的。
 *
 * 默认只显示**还有剩余的**前 6 个；用完的折叠成一句「另有 N 个已用完」。
 */
const packages = computed(() => credits.data.value?.packages ?? []);
const showAllPackages = ref(false);

const activePackages = computed(() => packages.value.filter((pkg) => pkg.limit - pkg.used > 0));
const exhaustedCount = computed(() => packages.value.length - activePackages.value.length);

const visiblePackages = computed(() => {
  if (showAllPackages.value) return packages.value;
  return activePackages.value.slice(0, 6);
});

/**
 * 把「解析失败的原始报错」翻成人话。
 *
 * 实测：假凭据或登录态失效时，上游回的是 HTML（登录页/风控页），通道层 `res.json()`
 * 抛 `Unexpected token '<', "<html> <h..." is not valid JSON`。这句话对用户没有意义，
 * 但它指向的真相很有用——**凭据多半已经失效了**。
 */
function humanError(text: string): string {
  if (/is not valid JSON|Unexpected token '</iu.test(text)) {
    return `上游返回的是 HTML 而不是 JSON（多半被重定向到登录页或风控页）。这个号的凭据可能已失效，先点「检测」验一下。原始报错：${text}`;
  }
  return text;
}

/** 这些模型被可见性挡住了——列表里要标出来，否则「有模型但 DSH 看不到」查不出来。 */
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

    <!--
      账号头：**不用 CardPanel**。那个组件的标题栏只放纯文本，这里要放徽标、余额和按钮，
      塞进 actions 插槽会让「标题」变成空白一条、按钮悬在右上角，看着像没加载出来。
    -->
    <section class="card">
      <div class="body">
        <div class="ahead">
          <span class="aid">{{ account?.id ?? id }}</span>
          <span class="name">{{ account?.label }}</span>
          <StatusBadge
            v-if="account"
            :status="account.status"
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

        <!--
          用 `role="group"` + `aria-pressed`，**不是** `tablist/tab`。
          tab 模式要求有 `tabpanel` 和方向键支持，而这里切换会改路由、内容区也没有
          包裹成 panel——半吊子的 ARIA 比没有更糟（读屏会说「选项卡 1/3」但不响应左右键）。
          和 TrendChart 的维度切换按钮保持同一套语义。
        -->
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

    <!-- ---------------------------------------------------------------- 概览 -->
    <template v-if="tab === 'overview'">
      <div class="grid2">
        <CardPanel title="余额">
          <p v-if="credits.data.value?.error" class="err">{{ humanError(credits.data.value.error) }}</p>
          <template v-else>
            <!--
              别写 `?? 0`：credits 请求整体失败（账号被删、网关重启）时 data 是 null，
              `?? 0` 会把它显示成 0，而同一数字在账号头那里是 `—`。拉不到就是拉不到。
            -->
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

    <!-- ---------------------------------------------------------------- 用量 -->
    <template v-else-if="tab === 'usage'">
      <CardPanel title="近 14 天消耗">
        <TrendChart :daily="usage.data.value?.daily ?? []" :loading="usage.loading.value" dim="model" @select="openDay" />
      </CardPanel>

      <CardPanel :title="`按模型（${usageWindowLabel}）`" flush>
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
              <!-- 只有同时有 token 和积分（WorkBuddy 这类）的模型才有这个数；Trae 恒为 — -->
              <td class="num">{{ row.creditsPerKToken ?? '—' }}</td>
            </tr>
            <tr v-if="(usage.data.value?.byModel ?? []).length === 0"><td colspan="6" class="empty">还没有记录。</td></tr>
          </tbody>
        </table>
      </CardPanel>
    </template>

    <!-- ---------------------------------------------------------------- 模型 -->
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
            <!-- 空态要等**目录**请求结束，不是账号详情请求——否则硬刷新时会先闪一句「取不到」。 -->
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

/* 剩余为 0 的包用灰色——它们是历史，不该和还能用的包抢注意力。 */
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
