<script setup lang="ts">
/**
 * 账号页：**这一页只做管理动作**。
 *
 * 和概览的分工不动：概览回答「现在怎么样」，这里负责加号、验活、停用、换设备号、删除。
 * 所以这里不画趋势图、不重复余额明细——每行只留「够判断要不要动手」的两个数字（余额、今日），
 * 明细在账号详情页。
 *
 * ## 为什么按通道分组，而不是一张大表
 *
 * 「添加账号」这个动作发生在**通道**上（用户想的是「给 WorkBuddy 加一个号」），
 * 能加几个、能不能登录也是通道的能力。分组之后，添加按钮就落在它该在的地方，
 * 单账号通道加满时可以在同一行写清原因。
 *
 * ## 登录是这一页最复杂的部分
 *
 * 步骤：点「确认登录」→ **同步开一个空白窗**（借用户手势，否则弹窗被拦）→ 起任务 →
 * 轮询到授权链接 → 把链接填进那个窗口 → 后台等完成 → 刷新列表。
 * 细节和坑都在 `composables/useLoginTask.ts` 与 `LoginTaskPanel.vue` 的注释里。
 */
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { getAccounts, refreshAccountCredits, refreshChannelCredits, type CreditRefreshRow } from '@/api/accounts';
import { getChannels, looksOf } from '@/api/channels';
import { useAsync } from '@/composables/useAsync';
import { useFlash } from '@/composables/useFlash';
import { useLoginTask } from '@/composables/useLoginTask';
import { refreshNavCounts } from '@/composables/useNavCounts';
import { canAddAccount } from '@/utils/account';
import AccountRow from '@/components/AccountRow.vue';
import AddAccountPanel from '@/components/AddAccountPanel.vue';
import ChannelIcon from '@/components/ChannelIcon.vue';
import LoginTaskPanel from '@/components/LoginTaskPanel.vue';
import Toast from '@/components/Toast.vue';
import { errorText } from '@/utils/error';

const route = useRoute();
const router = useRouter();

const accountsState = useAsync(getAccounts);
const channelsState = useAsync(getChannels);

const accounts = computed(() => accountsState.data.value?.accounts ?? []);
const channelList = computed(() => accountsState.data.value?.channels ?? []);

/** 通道外观（图标 / 字母），只用来渲染，不参与任何判断。 */
const looks = computed(() => looksOf(channelsState.data.value?.channels));

/* ------------------------------ 主动刷新积分 ------------------------------ */

/**
 * 手动刷新拿回来的余额，按账号 id 覆盖到那几行上。
 *
 * **不整页重拉**：`useAsync` 的 `data` 是 `shallowRef`，重拉会把整棵树换掉——正展开的
 * 「更多」菜单、正在改的名字全被打断。只有这几个数字变了，就只换这几个数字。
 *
 * 覆盖而不是就地改：`shallowRef` 下就地改嵌套字段不会触发重渲染（改了也白改）。
 */
const creditPatch = ref<Record<string, CreditRefreshRow>>({});

/** 正在查的账号 / 通道。按钮据此禁用，避免连点把上游打满。 */
const refreshingAccounts = ref<Record<string, boolean>>({});
const refreshingChannels = ref<Record<string, boolean>>({});

const { flash, say } = useFlash({ duration: 6000 });

/** 按注册表顺序分组，每行带上所属通道的能力位 + 手动刷新回来的余额覆盖。 */
const groups = computed(() =>
  channelList.value.map((channel) => ({
    channel,
    rows: accounts.value
      .filter((account) => account.channelId === channel.id)
      .sort((a, b) => a.seq - b.seq)
      .map((account) => ({ ...account, ...creditPatch.value[account.id] })),
  })),
);

/**
 * 把一次刷新结果落进界面，并**如实报告失败**。
 *
 * 成功 → 右上角浮层（6 秒消失，不占版面）；失败 → 页内那条要人点「知道了」的错误条。
 * 两者分开是有意的：会自己消失的提示不能用来承载「这件事没成功」。
 */
function applyCredits(credits: Record<string, CreditRefreshRow>): void {
  const next = { ...creditPatch.value };
  const failures: string[] = [];
  let okCount = 0;
  for (const [id, row] of Object.entries(credits)) {
    next[id] = row;
    if (row.error) failures.push(`${id}：${row.error}`);
    else okCount += 1;
  }
  creditPatch.value = next;
  if (failures.length > 0) actionError.value = failures.join('；');
  if (okCount > 0) say(`已向上游确认 ${okCount} 个账号的积分`, 'ok');
}

async function refreshCreditsOfAccount(accountId: string): Promise<void> {
  if (refreshingAccounts.value[accountId]) return;
  refreshingAccounts.value = { ...refreshingAccounts.value, [accountId]: true };
  try {
    applyCredits((await refreshAccountCredits(accountId)).credits);
  } catch (error: any) {
    actionError.value = error?.message || String(error);
  } finally {
    refreshingAccounts.value = { ...refreshingAccounts.value, [accountId]: false };
  }
}

async function refreshCreditsOfChannel(channelId: string): Promise<void> {
  if (refreshingChannels.value[channelId]) return;
  refreshingChannels.value = { ...refreshingChannels.value, [channelId]: true };
  try {
    applyCredits((await refreshChannelCredits(channelId)).credits);
  } catch (error: any) {
    actionError.value = error?.message || String(error);
  } finally {
    refreshingChannels.value = { ...refreshingChannels.value, [channelId]: false };
  }
}

const adding = ref(false);
const actionError = ref<string | null>(null);

/** 已经在点击栈里开好的空白窗。拿到授权链接就把它导航过去。 */
let pendingWindow: Window | null = null;
/** 那个窗口有没有真的被导航过。false = 还停在 `about:blank`。 */
let pendingWindowUsed = false;

/**
 * 收掉「开了但没用上」的空白窗。
 *
 * 短信验证码式登录（Loomy）**根本不会给出授权链接**——它要的是面板里那个输入框。
 * 但我们仍然在点击栈里开了窗（否则拿不到手势），于是不关的话，用户会多出一个
 * 永远停在 about:blank 的标签页，而且它和被取消的登录没有任何视觉关联。
 */
function closeUnusedWindow(): void {
  if (pendingWindow && !pendingWindowUsed && !pendingWindow.closed) {
    try {
      pendingWindow.close();
    } catch {
      // 有些浏览器不允许脚本关闭自己打开的窗口；关不掉就算了，别抛。
    }
  }
  pendingWindow = null;
  pendingWindowUsed = false;
}

const login = useLoginTask({
  onFirstUrl: (url) => {
    const win = pendingWindow;
    pendingWindowUsed = true;
    if (!win || win.closed) return; // 被拦了：面板里始终有链接，不用额外提示。
    try {
      win.location.href = url;
    } catch {
      // 跨源赋值失败极少数情况下会抛（浏览器策略）。链接仍然在面板上。
    }
  },
  onSettled: (settled) => {
    closeUnusedWindow();
    // 任务结束了，地址栏不该再带着它——否则刷新会恢复一个已经结束的任务面板。
    clearTaskQuery();
    if (settled.state === 'done') {
      void accountsState.refresh();
      // 新号已经进列表了，导航条上的「账号 N」也得跟上。
      void refreshNavCounts();
    }
  },
});

const task = computed(() => login.task.value);
const taskError = computed(() => login.error.value);

const channelLabel = computed(() => {
  const want = task.value?.channelId ?? '';
  return channelList.value.find((channel) => channel.id === want)?.label ?? want;
});

function clearTaskQuery(): void {
  const query = { ...route.query };
  delete query.channel;
  delete query.task;
  void router.replace({ query });
}

function rememberTask(channelId: string, taskId: string): void {
  void router.replace({ query: { ...route.query, channel: channelId, task: taskId } });
}

/**
 * 起一次登录。
 *
 * `window.open` 必须在 `await` 之前调用——它是用户点击的直接下游，浏览器才认这个手势。
 * 打开失败（返回 null）也要继续：面板里会给出手动链接。
 */
async function startLogin(channelId: string): Promise<void> {
  adding.value = false;
  actionError.value = null;

  // **只有 URL 式登录才开窗**：授权页必须借这次点击的手势先开好空白窗，否则被弹窗拦截。
  // 表单式（短信验证码 / 粘贴 cookie）不产生授权地址，开了就是一个永远白着的标签页——
  // 豆包和 Loomy 都会中这个。用通道自述的 `opensWindow` 判断，不按通道 id 分支。
  const channel = channelList.value.find((item) => item.id === channelId);
  if (channel?.opensWindow !== false) {
    pendingWindow = window.open('about:blank', '_blank');
    pendingWindowUsed = false;
  }

  try {
    const created = await login.start(channelId);
    rememberTask(channelId, created.taskId);
  } catch (error) {
    closeUnusedWindow();
    actionError.value = errorText(error);
  }
}

function closeTask(): void {
  closeUnusedWindow();
  login.reset();
  clearTaskQuery();
}

/** 标题条上要不要显示「+ 添加」。规则和「添加账号」面板共用一份。 */
function canAdd(channelId: string): boolean {
  const channel = channelList.value.find((item) => item.id === channelId);
  return channel ? canAddAccount(channel, accounts.value) : false;
}

/**
 * 通道报给上游的版本号，拼成一行给人看。
 *
 * 各家字段名和个数都不同（WorkBuddy 三个、Qoder 一个），所以**只列实际有的**，
 * 不补空值——`channelVersion: —` 会让人以为「这个字段读失败」。
 * `clientVersion` 排最前：它是换令牌的门禁字段，排查「客户端太旧」先看它。
 */
function versionText(channel: { identity?: Record<string, string> }): string {
  const identity = channel.identity ?? {};
  const order = ['clientVersion', 'channelVersion', 'ideVersion', 'appVersion'];
  const keys = [...order.filter((key) => identity[key]), ...Object.keys(identity).filter((key) => !order.includes(key))];
  if (keys.length === 0) return '';
  // 只有一个字段时省略字段名（`0.5.18` 比 `clientVersion 0.5.18` 好读）。
  if (keys.length === 1) return identity[keys[0]];
  return keys.map((key) => `${key.replace(/Version$/, '')} ${identity[key]}`).join(' · ');
}


/**
 * 页面级错误条。
 *
 * **有任务面板时不重复显示 `login.error`**：回填失败这类错误已经在面板里出现一次，
 * 上面再挂一条一模一样的只会让人以为出了两件事。没有面板时（比如从地址栏恢复任务
 * 却发现网关重启过）它必须出现在这里，否则用户看不到任何反馈。
 */
const error = computed(
  () =>
    actionError.value
    || (task.value ? null : login.error.value)
    || accountsState.error.value
    || channelsState.error.value,
);
const loading = computed(() => accountsState.loading.value);

function dismissError(): void {
  actionError.value = null;
  // 没有任务面板时，这条错误是从地址栏恢复任务失败留下的——顺手把那段 query 抹掉，
  // 否则刷新一次它又回来了。
  if (!task.value) {
    login.reset();
    clearTaskQuery();
  }
}

function refresh(): void {
  void accountsState.refresh();
  void channelsState.refresh();
}

/** 某一行改了数据（改名、停用、删除…）：重拉列表 + 刷新导航条计数。 */
function onAccountChanged(): void {
  void accountsState.refresh();
  void refreshNavCounts();
}

onMounted(() => {
  // 地址栏里带着任务句柄 = 刷新前正在登录，接上它。网关侧的任务不因浏览器刷新而消失。
  const channel = typeof route.query.channel === 'string' ? route.query.channel : '';
  const taskId = typeof route.query.task === 'string' ? route.query.task : '';
  if (channel && taskId) void login.resume(channel, taskId);
});
</script>

<template>
  <div>
    <p v-if="error" class="alert bad">
      <span>{{ error }}</span>
      <button type="button" class="btn sm" @click="dismissError">知道了</button>
    </p>

    <!--
      手动刷新积分的**成功**回执走右上角浮层（不占版面、不推内容）。
      失败不走浮层而是回到上面那条 `error`：要人读、要点「知道了」，6 秒就消失会漏掉。
    -->
    <Toast v-if="flash" :text="flash.text" :tone="flash.tone" />

    <div class="toolbar">
      <button type="button" class="btn primary" :aria-expanded="adding" @click="adding = !adding">
        {{ adding ? '收起' : '+ 添加账号' }}
      </button>
      <span class="grow" />
      <button type="button" class="btn ghost sm" :disabled="loading" @click="refresh">
        {{ loading ? '读取中…' : '刷新' }}
      </button>
    </div>

    <AddAccountPanel
      v-if="adding"
      :channels="channelList"
      :accounts="accounts"
      :look="looks"
      @start="startLogin"
      @close="adding = false"
    />

    <LoginTaskPanel
      v-if="task"
      :task="task"
      :urls="login.urls.value"
      :error="taskError"
      :busy="login.busy.value"
      :channel-label="channelLabel"
      @answer="login.answer($event)"
      @cancel="login.cancel()"
      @close="closeTask"
    />

    <section v-for="group in groups" :key="group.channel.id" class="card">
      <div class="title">
        <ChannelIcon
          :icon="looks(group.channel.id, group.channel.label).icon"
          :letter="looks(group.channel.id, group.channel.label).letter"
          :size="18"
          :alt="group.channel.label"
        />
        <span>{{ group.channel.label }}</span>
        <code>{{ group.channel.idPrefix }}</code>
        <span
          v-if="versionText(group.channel)"
          class="version"
          :title="`报给上游的客户端版本号：${versionText(group.channel)}`"
        >{{ versionText(group.channel) }}</span>
        <span class="muted small">
          {{ group.rows.length }} 个账号{{ group.channel.multiAccount ? '' : ' · 单账号通道' }}
        </span>
        <span v-if="!group.channel.canLogin" class="muted small">· 不支持自助登录</span>
        <span class="grow" />
        <!--
          通道级「刷新积分」：把这个通道下所有号一起问一遍（后端并发，各自记错）。
          一行一个号的通道它也照常出现——少点一次是一次。
        -->
        <button
          v-if="group.rows.length > 0"
          type="button"
          class="btn ghost sm"
          :disabled="refreshingChannels[group.channel.id]"
          :title="`去上游读一次 ${group.channel.label} 全部账号的积分`"
          @click="refreshCreditsOfChannel(group.channel.id)"
        >
          {{ refreshingChannels[group.channel.id] ? '查询中…' : '刷新积分' }}
        </button>
        <button
          v-if="group.channel.canLogin && canAdd(group.channel.id)"
          type="button"
          class="btn sm"
          @click="startLogin(group.channel.id)"
        >
          + 添加
        </button>
      </div>

      <div class="body flush">
        <p v-if="group.rows.length === 0" class="empty">
          还没有账号。{{
            group.channel.canLogin ? '点右上「+ 添加」登录一个。' : '这个通道不支持自助登录。'
          }}
        </p>
        <AccountRow
          v-for="account in group.rows"
          :key="account.id"
          :account="account"
          :channel="group.channel"
          :refreshing="refreshingAccounts[account.id]"
          @changed="onAccountChanged"
          @login="startLogin(group.channel.id)"
          @refresh="refreshCreditsOfAccount(account.id)"
        />
      </div>
    </section>

    <p class="foot">
      一个账号 = 该通道下的一个上游号，模型 id 的前半段就是它（<code>wb-1/hy4free</code>）——
      DSH 里选哪个 id 就是在选花谁的钱。加号、删号之后回 DSH 设置页重新「获取可用模型」，
      模型清单是快照，不会自己变。
    </p>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.alert span {
  flex: 1;
  min-width: 240px;
}

.card .title {
  gap: 8px;
}

/* 版本号比通道名弱、比 `idPrefix` 更弱：它是排查用的辅助信息，不该抢视线。 */
.card .title .version {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  background: var(--surface-2, rgba(127, 127, 127, 0.12));
  border-radius: 4px;
  padding: 1px 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 40ch;
}

.card .body.flush {
  padding: 4px 8px 12px;
}

.empty {
  margin: 8px 0 4px 24px;
  color: var(--muted);
  font-size: 12px;
}

.foot {
  color: var(--muted);
  font-size: 12px;
  margin: 4px 0 0;
}
</style>
