<script setup lang="ts">
import { computed, ref } from 'vue';

import { changePassword } from '@/api/config';
import { errorText } from '@/utils/error';

const props = withDefaults(
  defineProps<{
    resetOnSuccess?: boolean;
  }>(),
  { resetOnSuccess: true },
);

const emit = defineEmits<{ (e: 'done'): void }>();

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
