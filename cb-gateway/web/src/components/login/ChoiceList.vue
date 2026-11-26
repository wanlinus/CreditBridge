<script setup lang="ts">
/**
 * 一组可选项卡片：登录方式、账号选择、验证方式都用它。
 *
 * 三种形态共用一个组件，因为它们长得一样、只是内容不同：
 * - 纯文字（登录方式："短信验证码 / 导入 cookie"）
 * - 带头像（账号选择：豆包两个子账号）
 * - 带禁用原因（验证方式：抖音授权做不了，灰掉并写明为什么）
 *
 * **禁用不等于隐藏**：做不到的方式也要显示，用户才知道上游到底要什么，
 * 否则他会以为网关漏了一种。
 */
import type { LoginPromptOption } from '@/api/accounts';

defineProps<{
  label?: string;
  options: LoginPromptOption[];
  disabled: boolean;
}>();

defineEmits<{ (e: 'choose', value: string): void }>();
</script>

<template>
  <div class="choices">
    <p v-if="label" class="choices-label">{{ label }}</p>
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      class="choice"
      :class="{ 'with-avatar': option.avatar, 'is-disabled': option.disabled }"
      :disabled="disabled || option.disabled"
      :title="option.disabled ? option.hint : undefined"
      @click="$emit('choose', option.value)"
    >
      <img
        v-if="option.avatar"
        class="avatar"
        :src="option.avatar"
        :alt="option.label"
        referrerpolicy="no-referrer"
      />
      <span class="choice-text">
        <span class="choice-label">
          {{ option.label }}
          <span v-if="option.disabled" class="badge">做不了</span>
        </span>
        <span v-if="option.subtitle" class="choice-hint">{{ option.subtitle }}</span>
        <span v-else-if="option.hint" class="choice-hint">{{ option.hint }}</span>
      </span>
      <span v-if="!option.disabled" class="chev" aria-hidden="true">›</span>
    </button>
  </div>
</template>

<style scoped>
.choices {
  display: grid;
  gap: 8px;
}

.choices-label {
  margin: 0 0 2px;
  font-size: 13px;
  color: var(--text);
}

.choice {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 2px;
  text-align: left;
  padding: 11px 13px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 9px;
  cursor: pointer;
  font: inherit;
  color: inherit;
  transition:
    border-color 0.12s,
    background 0.12s,
    transform 0.06s;
}

/* 账号卡片：头像在左、文字在右，和客户端的账号选择界面同形。 */
.choice.with-avatar {
  grid-template-columns: 40px 1fr auto;
  align-items: center;
  gap: 10px;
}

.choice:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--accent-weak);
}

.choice:active:not(:disabled) {
  transform: scale(0.995);
}

.choice:disabled {
  cursor: not-allowed;
}

/* 做不了的方式：压暗并划掉标签。**不隐藏**——用户要知道上游给了哪些方式。 */
.choice.is-disabled {
  opacity: 0.5;
  background: var(--card2);
}

.avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  object-fit: cover;
  background: var(--card2);
  /* 头像加载失败时不要显示破图标，留个底色就够 */
  color: transparent;
}

.choice-text {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.choice-label {
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
}

.badge {
  font-size: 10px;
  font-weight: 500;
  color: var(--muted);
  background: var(--card2);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 0 4px;
}

.choice-hint {
  font-size: 11px;
  color: var(--muted);
  line-height: 1.45;
}

.chev {
  color: var(--muted);
  font-size: 18px;
  line-height: 1;
  align-self: center;
  opacity: 0.5;
}

.choice:hover:not(:disabled) .chev {
  color: var(--accent);
  opacity: 1;
}
</style>
