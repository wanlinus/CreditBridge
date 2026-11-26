<script setup lang="ts">
/**
 * 图形验证码卡片（豆包 1105 风控）：嵌上游验证页，用户拖一下滑块。
 *
 * 数据来源是 `verify_center_decision_conf`，**不是**响应顶层的 `captcha` 字段
 * （那个一直是空的，2026-11-26 之前一直查错字段）。
 *
 * iframe 必须给 `allow-scripts allow-same-origin`：验证页本身要跑 JS 和读自己的 cookie，
 * 少一个就白板。`referrerpolicy="no-referrer"` 避免把网关地址带给字节的验证域名。
 */
import { computed } from 'vue';
import type { LoginPromptChallenge } from '@/api/accounts';

const props = defineProps<{
  challenge: LoginPromptChallenge;
  disabled: boolean;
  /** 验证类型的中文名，父组件已经算好。 */
  label: string;
}>();

defineEmits<{ (e: 'done'): void }>();

/**
 * 验证页地址。`challenge_code` 用 `decision_conf.detail`（约 392 字符），
 * 这是客户端 `TTGCaptcha` 加载 iframe 时传的东西。
 */
const src = computed(() => {
  const url = new URL(props.challenge.url);
  url.searchParams.set('challenge_code', props.challenge.code);
  url.searchParams.set('hideCloseBtn', 'true');
  if (props.challenge.subtype) url.searchParams.set('subtype', props.challenge.subtype);
  if (props.challenge.ticket) url.searchParams.set('verify_ticket', props.challenge.ticket);
  return url.toString();
});
</script>

<template>
  <div class="captcha">
    <div class="head">
      <span class="type">{{ label }}</span>
      <span class="hint">在上面的验证区里完成操作，通过后点下面的按钮</span>
    </div>
    <iframe
      class="frame"
      :src="src"
      :title="label"
      referrerpolicy="no-referrer"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
    />
    <button type="button" class="btn primary sm" :disabled="disabled" @click="$emit('done')">
      我已完成验证
    </button>
  </div>
</template>

<style scoped>
.captcha {
  display: grid;
  gap: 8px;
}

.head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}

.type {
  font-size: 13px;
  font-weight: 600;
}

.hint {
  font-size: 11px;
  color: var(--muted);
}

/* 高度给足，不然滑块 / 点选题容易被裁掉。 */
.frame {
  width: 100%;
  height: 360px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: #fff;
}

.btn {
  justify-self: start;
}
</style>
