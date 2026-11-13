<script setup lang="ts">
import { computed, ref } from 'vue';

import { checkinAll, getCheckinLog, type CheckinLogEntry } from '@/api/checkin';
import { useAsync } from '@/composables/useAsync';
import { useFlash } from '@/composables/useFlash';
import { fmtNum, fmtTime } from '@/utils/format';
import CardPanel from '@/components/CardPanel.vue';
import CheckinBadge from '@/components/CheckinBadge.vue';
import ToneBadge from '@/components/ToneBadge.vue';
import { errorText } from '@/utils/error';

const state = useAsync(getCheckinLog);
const busy = ref(false);
const { flash, say } = useFlash({ duration: 6000 });

const entries = computed<CheckinLogEntry[]>(() => state.data.value?.entries ?? []);
const names = computed(() => state.data.value?.accountNames ?? {});

const failedCount = computed(() => entries.value.filter((entry) => entry.status === 'error').length);

async function runAll(): Promise<void> {
  busy.value = true;
  try {
    const result = await checkinAll();
    void state.refresh();
    say(
      result.results.length === 0
        ? '没有可签到的账号（都未就绪或不支持签到）'
        : result.failCount === 0
          ? `已签完 ${result.okCount} 个账号`
          : `${result.okCount} 个成功，${result.failCount} 个失败——看下面标红的那几行`,
      result.failCount === 0 ? 'ok' : 'bad',
    );
  } catch (error) {
    say(errorText(error), 'bad');
  } finally {
    busy.value = false;
  }
}

function accountName(id: string): string {
  return names.value[id] ?? id;
}
</script>

<template>
  <div>
    <p v-if="state.error.value" class="alert bad">{{ state.error.value }}</p>

    <div class="toolbar">
      <button type="button" class="btn primary" :disabled="busy" @click="runAll">
        {{ busy ? '签到中…' : '一键签到' }}
      </button>
      <span class="muted small">
        每天自动签一次；失败会按阶梯重试（10 / 30 / 60 分钟）。这里点一次是「现在立刻试一遍」，
        不跳过今天已签的。
      </span>
      <span class="grow" />
      <button type="button" class="btn ghost sm" :disabled="state.loading.value" @click="state.refresh()">
        {{ state.loading.value ? '读取中…' : '刷新' }}
      </button>
    </div>

    <p v-if="flash" class="flash" :class="flash.tone">{{ flash.text }}</p>

    <CardPanel :title="`签到日志（${entries.length} 条）`" flush>
      <template #actions>
        <span class="muted small">新的在前</span>
        <ToneBadge v-if="failedCount" tone="bad" :label="`${failedCount} 条失败`" />
      </template>

      <table class="table">
        <thead>
          <tr>
            <th>时间</th>
            <th>账号</th>
            <th>结果</th>
            <th class="num">积分</th>
            <th class="num">连签</th>
            <th>来源</th>
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(entry, i) in entries" :key="i" :class="{ badrow: entry.status === 'error' }">
            <td class="mono">{{ fmtTime(entry.ts) }}</td>
            <td>{{ accountName(entry.account) }}</td>
            <td><CheckinBadge :status="entry.status" :title="entry.message" /></td>
            <td class="num">{{ typeof entry.credits === 'number' ? fmtNum(entry.credits) : '—' }}</td>
            <td class="num">{{ entry.streakDays ?? '—' }}</td>
            <td class="muted small">{{ entry.source === 'auto' ? '自动' : '手动' }}</td>
            <td class="msg" :title="entry.message || ''">{{ entry.message || '' }}</td>
          </tr>
          <tr v-if="entries.length === 0 && !state.loading.value">
            <td colspan="7" class="empty">还没有签到记录。到点会自动跑一次。</td>
          </tr>
        </tbody>
      </table>
    </CardPanel>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.flash {
  margin: 0 0 12px;
  font-size: 12px;
}

.flash.ok {
  color: var(--ok);
}

.flash.bad {
  color: var(--bad);
}

.num {
  font-variant-numeric: tabular-nums;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}

.msg {
  color: var(--muted);
  font-size: 12px;
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.badrow {
  background: #fffafa;
}

</style>
