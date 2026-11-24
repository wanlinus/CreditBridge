<script setup lang="ts">
/**
 * 改密表单：**强制改密页和设置页共用这一个**。
 *
 * ## 为什么必须共用
 *
 * 两处调的是同一个 `POST /api/password`，但校验曾经是分叉的：
 * 强制改密页有「两次不一致」的前端检查、没有 `minlength`；
 * 设置页有 `minlength="6"`、没有不一致检查。同一条规则在两个地方说法不同，
 * 用户在哪一页遇到哪种提示取决于运气。
 *
 * 现在只有一份：不一致、太短都在这拦一次，后端仍然是最终裁决。
 *
 * ## 为什么 `submit` 成功后不回跳
 *
 * 回跳目标是调用方的事——强制改密要进概览，设置页要留在原地。
 * `@done` 事件把「成功了」这件事交出去，跳不跳由调用方决定。
 */
import { computed, ref } from 'vue';

import { changePassword } from '@/api/config';
import { errorText } from '@/utils/error';

const props = withDefaults(
  defineProps<{
    /** 成功后要不要清空输入框（设置页会，强制改密页马上要跳走）。 */
    resetOnSuccess?: boolean;
  }>(),
  { resetOnSuccess: true },
);

const emit = defineEmits<{ (e: 'done'): void }>();

/** `changePassword()` 内部的最小长度要求。放这里而不是每个页面各抄一遍数字。 */
const MIN_LENGTH = 6;

const current = ref('');
const next = ref('');
const confirm = ref('');
const busy = ref(false);
const note = ref<{ text: string; tone: 'ok' | 'bad' } | null>(null);

const tooShort = computed(() => next.value !== '' && next.value.length < MIN_LENGTH);
const mismatch = computed(() => confirm.value !== '' && next.value !== confirm.value);
const blocked = computed(() => busy.value || tooShort.value || mismatch.value);

async function submit(): Promise<void> {
  if (blocked.value) return;
  busy.value = true;
  note.value = null;
  try {
    await changePassword(current.value, next.value, confirm.value);
    if (props.resetOnSuccess) {
      current.value = '';
      next.value = '';
      confirm.value = '';
    }
    note.value = { text: '密码已更新。已发出的 API key 不受影响。', tone: 'ok' };
    emit('done');
  } catch (error) {
    note.value = { text: errorText(error), tone: 'bad' };
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form class="pw" @submit.prevent="submit">
    <label>
      <span>当前密码</span>
      <input v-model="current" type="password" autocomplete="current-password" required />
    </label>
    <label>
      <span>新密码</span>
      <input v-model="next" type="password" autocomplete="new-password" required />
    </label>
    <label>
      <span>再输一次</span>
      <input v-model="confirm" type="password" autocomplete="new-password" required />
    </label>

    <p v-if="tooShort" class="err">新密码至少 {{ MIN_LENGTH }} 位。</p>
    <p v-else-if="mismatch" class="err">两次输入的新密码不一致。</p>

    <div class="acts">
      <button type="submit" class="btn primary" :disabled="blocked">
        {{ busy ? '保存中…' : '改密码' }}
      </button>
      <slot name="extra" />
    </div>

    <p v-if="note" class="note" :class="note.tone">{{ note.text }}</p>
  </form>
</template>

<style scoped>
.pw {
  display: grid;
  gap: 10px;
}

label {
  display: grid;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}

input {
  font: inherit;
  font-size: 13px;
  color: var(--fg);
  padding: 6px 10px;
  border: 1px solid var(--line);
  border-radius: 7px;
  outline: none;
  background: var(--card);
}

input:focus {
  border-color: var(--accent);
}

.acts {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

.note {
  margin: 0;
  font-size: 12px;
}

.note.ok {
  color: var(--ok);
}

.note.bad {
  color: var(--bad);
}
</style>
