<script setup lang="ts">
import { useRouter } from 'vue-router';

import PasswordForm from '@/components/PasswordForm.vue';

const router = useRouter();

function onDone(): void {
  void router.replace({ name: 'overview' });
}
</script>

<template>
  <div class="auth">
    <div class="panel">
      <h1>设置新密码</h1>
      <p class="sub">首次使用必须先改掉默认密码，改完才能访问其他页面。</p>

      <PasswordForm :reset-on-success="false" @done="onDone" />

      <p class="hint">改密不影响已生成的 API key，profile 不用跟着改。</p>
    </div>
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
  max-width: 380px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 28px 26px 22px;
}

h1 {
  margin: 0;
  font-size: 19px;
  font-weight: 600;
}

.sub {
  margin: 6px 0 22px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.7;
}

.hint {
  margin: 16px 0 0;
  color: var(--muted);
  font-size: 12px;
}
</style>
