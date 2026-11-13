<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { getHealth, updateConfig } from '@/api/config';
import { useAsync } from '@/composables/useAsync';
import { fmtTime } from '@/utils/format';
import { errorText } from '@/utils/error';
import CardPanel from '@/components/CardPanel.vue';
import PasswordForm from '@/components/PasswordForm.vue';

const health = useAsync(getHealth);

const checkinTime = ref('');
const savingTime = ref(false);
const timeNote = ref<{ text: string; tone: 'ok' | 'bad' } | null>(null);

const currentTime = computed(() => health.data.value?.checkinTime ?? '09:00');

watch(
  () => health.data.value?.checkinTime,
  (value) => {
    if (value && checkinTime.value === '') checkinTime.value = value;
  },
  { immediate: true },
);

async function saveTime(): Promise<void> {
  savingTime.value = true;
  timeNote.value = null;
  try {
    const result = await updateConfig({ checkinTime: checkinTime.value });
    void health.refresh();
    timeNote.value = { text: `已改为 ${result.checkinTime}，到点自动生效（不用重启）。`, tone: 'ok' };
  } catch (error) {
    timeNote.value = { text: errorText(error), tone: 'bad' };
  } finally {
    savingTime.value = false;
  }
}

const info = computed(() => {
  const h = health.data.value;
  if (!h) return [];
  const startedTs = Date.parse(String(h.startedAt));
  return [
    { label: '版本', value: h.version },
    { label: '启动于', value: Number.isFinite(startedTs) ? fmtTime(startedTs) : String(h.startedAt) },
    { label: '账号', value: `${h.accounts?.length ?? 0} 个` },
    { label: '模型 id 形如', value: h.modelIdFormat },
  ];
});
</script>

<template>
  <div>
    <p v-if="health.error.value" class="alert bad">{{ health.error.value }}</p>

    <div class="grid2">
      <CardPanel title="改密码">
        <p class="hint">
          默认账号 <code>admin</code>。改密<b>不会</b>让已发出的 API key 失效——那是两套独立凭据。
        </p>
        <PasswordForm />
      </CardPanel>

      <CardPanel title="每日签到时间">
        <p class="hint">
          到点自动签一次。失败按阶梯重试（10 / 30 / 60 分钟），走完放弃——所以这里只需要
          设一个「大概什么时候开始试」。
        </p>
        <form class="tf" @submit.prevent="saveTime">
          <label>
            <span>时间（24 小时制）</span>
            <input v-model="checkinTime" type="time" :placeholder="currentTime" required />
          </label>
          <p class="muted small">当前：<code>{{ currentTime }}</code></p>
          <div>
            <button type="submit" class="btn primary" :disabled="savingTime || checkinTime === ''">
              {{ savingTime ? '保存中…' : '保存' }}
            </button>
          </div>
        </form>
        <p v-if="timeNote" class="note" :class="timeNote.tone">{{ timeNote.text }}</p>
      </CardPanel>
    </div>

    <CardPanel title="网关信息">
      <dl class="kv">
        <template v-for="row in info" :key="row.label">
          <dt>{{ row.label }}</dt>
          <dd><code>{{ row.value }}</code></dd>
        </template>
        <dt>健康检查</dt>
        <dd class="muted small">
          <code>/api/health</code> 要认证，别拿它做容器探针——探针打的是 <code>/login</code>（公开的壳）。
        </dd>
      </dl>
    </CardPanel>
  </div>
</template>

<style scoped>
.grid2 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 16px;
  align-items: start;
}

.hint {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.8;
}

.tf {
  display: grid;
  gap: 10px;
}

.tf label {
  display: grid;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}

.tf input {
  font: inherit;
  font-size: 13px;
  color: var(--fg);
  padding: 6px 10px;
  border: 1px solid var(--line);
  border-radius: 7px;
  outline: none;
  background: var(--card);
}

.tf input:focus {
  border-color: var(--accent);
}

.note {
  margin: 10px 0 0;
  font-size: 12px;
}

.kv {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 14px;
  margin: 0;
  font-size: 13px;
}

.kv dt {
  color: var(--muted);
  font-size: 12px;
}

.kv dd {
  margin: 0;
}

</style>
