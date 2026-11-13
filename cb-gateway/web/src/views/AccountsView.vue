<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { getAccounts } from '@/api/accounts';
import { getChannels, type ChannelAppearance } from '@/api/channels';
import { useAsync } from '@/composables/useAsync';
import { useLoginTask } from '@/composables/useLoginTask';
import { refreshNavCounts } from '@/composables/useNavCounts';
import { canAddAccount } from '@/utils/account';
import AccountRow from '@/components/AccountRow.vue';
import AddAccountPanel from '@/components/AddAccountPanel.vue';
import ChannelIcon from '@/components/ChannelIcon.vue';
import LoginTaskPanel from '@/components/LoginTaskPanel.vue';
import { errorText } from '@/utils/error';

const route = useRoute();
const router = useRouter();

const accountsState = useAsync(getAccounts);
const channelsState = useAsync(getChannels);

const accounts = computed(() => accountsState.data.value?.accounts ?? []);
const channelList = computed(() => accountsState.data.value?.channels ?? []);

const looks = computed(() => {
  const map = new Map<string, ChannelAppearance>();
  for (const channel of channelsState.data.value?.channels ?? []) map.set(channel.id, channel);
  return map;
});

const groups = computed(() =>
  channelList.value.map((channel) => ({
    channel,
    rows: accounts.value
      .filter((account) => account.channelId === channel.id)
      .sort((a, b) => a.seq - b.seq),
  })),
);

const adding = ref(false);
const actionError = ref<string | null>(null);

let pendingWindow: Window | null = null;
let pendingWindowUsed = false;

function closeUnusedWindow(): void {
  if (pendingWindow && !pendingWindowUsed && !pendingWindow.closed) {
    try {
      pendingWindow.close();
    } catch {
    }
  }
  pendingWindow = null;
  pendingWindowUsed = false;
}

const login = useLoginTask({
  onFirstUrl: (url) => {
    const win = pendingWindow;
    pendingWindowUsed = true;
    if (!win || win.closed) return;
    try {
      win.location.href = url;
    } catch {
    }
  },
  onSettled: (settled) => {
    closeUnusedWindow();
    clearTaskQuery();
    if (settled.state === 'done') {
      void accountsState.refresh();
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

const taskAnchor = ref<HTMLElement | null>(null);

function revealTask(): void {
  void nextTick(() => taskAnchor.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
}

async function startLogin(channelId: string): Promise<void> {
  adding.value = false;
  actionError.value = null;
  pendingWindow = window.open('about:blank', '_blank');
  pendingWindowUsed = false;
  try {
    const created = await login.start(channelId);
    rememberTask(channelId, created.taskId);
    revealTask();
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

function canAdd(channelId: string): boolean {
  const channel = channelList.value.find((item) => item.id === channelId);
  return channel ? canAddAccount(channel, accounts.value) : false;
}

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
  if (!task.value) {
    login.reset();
    clearTaskQuery();
  }
}

function refresh(): void {
  void accountsState.refresh();
  void channelsState.refresh();
}

function onAccountChanged(): void {
  void accountsState.refresh();
  void refreshNavCounts();
}

onMounted(() => {
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
      :looks="looks"
      @start="startLogin"
      @close="adding = false"
    />

    <div ref="taskAnchor" />

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
          :icon="looks.get(group.channel.id)?.icon ?? null"
          :letter="looks.get(group.channel.id)?.letter ?? group.channel.label.slice(0, 1)"
          :size="18"
          :alt="group.channel.label"
        />
        <span>{{ group.channel.label }}</span>
        <code>{{ group.channel.idPrefix }}</code>
        <span class="muted small">
          {{ group.rows.length }} 个账号{{ group.channel.multiAccount ? '' : ' · 单账号通道' }}
        </span>
        <span v-if="!group.channel.canLogin" class="muted small">· 不支持自助登录</span>
        <span class="grow" />
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
          @changed="onAccountChanged"
          @login="startLogin(group.channel.id)"
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
