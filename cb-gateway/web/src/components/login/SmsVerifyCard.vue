<script setup lang="ts">
/**
 * 短信验证卡片：用户自己用手机发一条短信，网关只负责确认收到没有。
 *
 * **拆成三段显示是有原因的**：号码、内容、被验证的手机号，三样缺一样都发不对，
 * 所以各自独立成行、各自可复制。挤成一句话用户会复制错。
 *
 * `useUserSendSms` 这个名字是刻意的：**这一步不产生任何短信**，
 * 发短信的是用户，网关只调 `/passport/upsms/verify/` 确认。
 */
import { computed } from 'vue';

const props = defineProps<{
  /** 上游给的要发到的号码，比如 `10691859839103`。 */
  channelMobile?: string;
  /** 上游给的要发的正文，比如 `YZ`。 */
  smsContent?: string;
  /** 被验证的那个手机号（脱敏），比如 `155******33`。 */
  mobile?: string;
  disabled: boolean;
}>();

const steps = computed(() => {
  const list: { label: string; value: string; mono?: boolean }[] = [];
  if (props.mobile) list.push({ label: '用这个手机号', value: props.mobile, mono: true });
  if (props.smsContent) list.push({ label: '内容只写', value: props.smsContent, mono: true });
  if (props.channelMobile) list.push({ label: '发到这个号码', value: props.channelMobile, mono: true });
  return list;
});

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // 剪贴板不可用（非 https / 权限被拒）就静默失败：号码本来就摆在屏幕上了。
  }
}
</script>

<template>
  <div class="sms">
    <ol class="steps">
      <li v-for="step in steps" :key="step.label" class="step">
        <span class="step-label">{{ step.label }}</span>
        <button type="button" class="step-value" :class="{ mono: step.mono }" @click="copy(step.value)">
          {{ step.value }}
          <span class="copy">复制</span>
        </button>
      </li>
    </ol>
    <p class="note">
      短信由你自己用手机发出，网关只负责确认。发完等一两分钟，再点下面的按钮。
    </p>
  </div>
</template>

<style scoped>
.sms {
  display: grid;
  gap: 10px;
}

.steps {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
  counter-reset: step;
}

.step {
  display: grid;
  grid-template-columns: 92px 1fr;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: var(--card2);
  border-radius: 8px;
  counter-increment: step;
}

.step-label {
  font-size: 12px;
  color: var(--muted);
}

.step-value {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-self: start;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  color: var(--fg);
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
  text-align: left;
}

.step-value:hover .copy {
  opacity: 1;
}

/* 号码和验证码要能用等宽字体逐位核对，别让 0/O、1/l 混掉。 */
.mono {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  letter-spacing: 0.02em;
}

.copy {
  font-size: 10px;
  font-weight: 400;
  color: var(--accent);
  opacity: 0;
  transition: opacity 0.12s;
}

.note {
  margin: 0;
  font-size: 11px;
  color: var(--muted);
  line-height: 1.5;
}
</style>
