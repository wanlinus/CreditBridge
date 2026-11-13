<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { LoginTask } from '@/api/accounts';
import { fmtClock } from '@/utils/format';
import ToneBadge from '@/components/ToneBadge.vue';

const props = defineProps<{
  task: LoginTask;
  urls: string[];
  error: string | null;
  busy: boolean;
  channelLabel: string;
}>();

const emit = defineEmits<{
  (e: 'answer', value: string): void;
  (e: 'cancel'): void;
  (e: 'close'): void;
}>();

const value = ref('');

watch(
  () => props.task.prompt?.id,
  () => {
    value.value = '';
  },
);

const stateText = computed(() => {
  if (props.task.state === 'running') return '进行中…';
  if (props.task.state === 'done') return '已完成';
  if (props.task.state === 'cancelled') return '已取消';
  return '失败';
});

const tone = computed(() => {
  if (props.task.state === 'done') return 'ok';
  if (props.task.state === 'cancelled') return 'muted';
  if (props.task.state === 'error') return 'bad';
  return 'warn';
});

const inputType = computed(() => props.task.prompt?.inputType ?? 'text');

function submit(): void {
  const text = value.value.trim();
  if (text === '') return;
  emit('answer', text);
}
</script>

<template>
  <div class="panel login-task">
    <div class="head">
      <span class="title">{{ channelLabel }} 登录</span>
      <ToneBadge :tone="tone" :label="stateText" />
      <span class="muted small">开始于 {{ fmtClock(task.startedAt) }}</span>
      <span class="grow" />
      <button v-if="task.state === 'running'" type="button" class="btn sm" :disabled="busy" @click="emit('cancel')">
        取消登录
      </button>
      <button v-else type="button" class="btn sm ghost" @click="emit('close')">关闭</button>
    </div>

    <div class="body">
      <template v-if="task.state === 'running'">
        <div v-if="urls.length > 0" class="urls">
          <div v-for="(url, index) in urls" :key="url" class="url">
            <span class="tag">{{ urls.length > 1 ? `第 ${index + 1} 次授权` : '授权' }}</span>
            <a :href="url" target="_blank" rel="noreferrer">打开授权页</a>
            <span class="muted small">已尝试自动打开；没看到新标签页就点这个链接。</span>
          </div>
        </div>
        <p v-else class="muted small">
          正在等上游给出授权链接…（会自动打开；最多等 5 分钟）
        </p>

        <form v-if="task.prompt" class="prompt" @submit.prevent="submit">
          <label :for="`prompt-${task.prompt.id}`">{{ task.prompt.label }}</label>
          <input
            :id="`prompt-${task.prompt.id}`"
            :key="task.prompt.id"
            v-model="value"
            :type="inputType"
            :placeholder="task.prompt.placeholder || ''"
            :inputmode="inputType === 'number' ? 'numeric' : 'text'"
            autocomplete="off"
            required
          />
          <button type="submit" class="btn primary sm" :disabled="busy || value.trim() === ''">
            {{ task.prompt.submitLabel || '提交' }}
          </button>
        </form>
      </template>

      <p v-else-if="task.state === 'done'" class="ok">
        登录成功<template v-if="task.accountId">：账号 <code>{{ task.accountId }}</code> 已加入</template>。
      </p>
      <p v-else-if="task.state === 'cancelled'" class="muted">
        这次登录已经取消。想重新来一次就再点「添加账号」，或者在那一行点「重新登录」。
      </p>
      <p v-else class="bad">{{ task.message || '登录失败（上游没给原因）' }}</p>

      <p v-if="error" class="bad">{{ error }}</p>
    </div>
  </div>
</template>

<style scoped>
.panel {
  border: 1px solid var(--line);
  border-left: 3px solid var(--warn);
  border-radius: var(--radius);
  background: var(--card);
  box-shadow: var(--shadow);
  padding: 12px 14px;
  margin-bottom: 16px;
}

.head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.title {
  font-weight: 600;
  font-size: 13px;
}

.urls {
  display: grid;
  gap: 4px;
  margin-bottom: 8px;
}

.url {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
}

.tag {
  font-size: 11px;
  color: var(--muted);
  background: var(--card2);
  border-radius: 99px;
  padding: 1px 8px;
}

.prompt {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 8px;
  font-size: 13px;
}

.prompt input {
  font: inherit;
  font-size: 13px;
  padding: 4px 8px;
  border: 1px solid var(--line);
  border-radius: 7px;
  outline: none;
  width: 180px;
}

.prompt input:focus {
  border-color: var(--accent);
}

.ok {
  margin: 0;
  color: var(--ok);
  font-size: 13px;
}

.bad {
  margin: 4px 0 0;
  color: var(--bad);
  font-size: 13px;
}

</style>
