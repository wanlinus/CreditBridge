<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';

import { login } from '@/api/config';

const router = useRouter();

const username = ref('admin');
const password = ref('');
const error = ref<string | null>(null);
const busy = ref(false);

async function submit() {
  if (busy.value) return;
  error.value = null;
  busy.value = true;
  try {
    const result = await login(username.value, password.value);
    await router.replace({ name: result.mustChangePassword ? 'password' : 'overview' });
  } catch (err: any) {
    error.value = err?.message || String(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="auth">
    <form class="panel" @submit.prevent="submit">
      <h1><span class="dot" />积分桥</h1>
      <p class="sub">网关管理台</p>

      <label class="field">
        <span>用户名</span>
        <input v-model="username" name="username" autocomplete="username" />
      </label>

      <label class="field">
        <span>密码</span>
        <input v-model="password" type="password" name="password" autocomplete="current-password" autofocus />
      </label>

      <p v-if="error" class="err">{{ error }}</p>

      <button type="submit" :disabled="busy">{{ busy ? '登录中…' : '登录' }}</button>

      <p class="hint">
        默认账号 <code>admin</code> / <code>admin</code>，首次登录后会强制改密。
      </p>
    </form>
  </div>
</template>

<style scoped>
.auth {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
}

.panel {
  width: 100%;
  max-width: 340px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 28px 26px 22px;
}

h1 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 19px;
  font-weight: 600;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ok);
}

.sub {
  margin: 4px 0 22px;
  color: var(--muted);
  font-size: 13px;
}

.field {
  display: block;
  margin-bottom: 14px;
}

.field span {
  display: block;
  margin-bottom: 5px;
  font-size: 12px;
  color: var(--muted);
}

.field input {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  font: inherit;
  background: var(--card);
  color: var(--fg);
}

.field input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-weak);
}

button {
  width: 100%;
  margin-top: 6px;
  padding: 9px 12px;
  border: none;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  font: inherit;
  font-weight: 500;
  cursor: pointer;
}

button:disabled {
  opacity: 0.6;
  cursor: default;
}

.err {
  margin: 0 0 12px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--bad-bg);
  color: var(--bad);
  font-size: 13px;
}

.hint {
  margin: 16px 0 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.7;
}
</style>
