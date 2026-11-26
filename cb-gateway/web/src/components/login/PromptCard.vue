<script setup lang="ts">
/**
 * 当前这一步要用户填什么。**这里是登录弹窗的全部交互入口**。
 *
 * 按 `prompt` 上的字段分形态，优先级从特殊到一般：
 *   0. `sms`       → 短信验证三段信息（豆包 2046，用户自己去手机发）
 *   1. `challenge` → 图形验证码（豆包 1105，要拖滑块）
 *   2. `qrCode`    → 二维码（豆包 2046 扫码）
 *   3. `otpLength` → OTP 大格子（豆包 2046 推送，用户抄 6 位码）
 *   4. `options`   → 选项卡片（登录方式 / 选账号 / 选验证方式）
 *   5. 其余        → 文本输入框（手机号 / 验证码 / cookie）
 *
 * 这个顺序不能乱：一个 prompt 可能同时带 `options` 和别的，特殊的必须先判。
 */
import { ref } from 'vue';
import type { LoginPrompt } from '@/api/accounts';
import CaptchaCard from './CaptchaCard.vue';
import ChoiceList from './ChoiceList.vue';
import OtpInput from './OtpInput.vue';
import QrVerifyCard from './QrVerifyCard.vue';
import SmsVerifyCard from './SmsVerifyCard.vue';

const props = defineProps<{
  prompt: LoginPrompt;
  /** 网关还在处理上一步，控件应全部置灰。 */
  waiting: boolean;
  /** 上一步失败了，把原因摊在输入框上面。 */
  error: string | null;
}>();

const emit = defineEmits<{ (e: 'answer', value: string): void }>();

/** 文本输入框的值。换 prompt 时组件会被 `:key` 重建，所以不用手动清。 */
const text = ref('');

function answer(value: string): void {
  emit('answer', value);
}

/**
 * 文本输入提交。空值不提交——上游会回「缺少参数」，用户看不出是自己没填。
 *
 * **`text` 一定是字符串**：模板里没有用 `type="number"`，原因见下面那个注释。
 * 但仍然防御一下——非字符串进来（比如上游哪天塞了个值）不该让整个弹窗崩掉。
 */
function submitText(): void {
  const value = String(text.value ?? '').trim();
  if (value === '') return;
  answer(value);
}
</script>

<template>
  <div class="prompt">
    <p class="label">{{ prompt.label }}</p>

    <!-- 0. 短信验证：三段信息分开显示，各自可复制 -->
    <SmsVerifyCard
      v-if="prompt.sms"
      :channel-mobile="prompt.sms.channelMobile"
      :sms-content="prompt.sms.content"
      :mobile="prompt.sms.mobile"
      :disabled="waiting"
    />

    <!-- 1. 图形验证码 -->
    <CaptchaCard
      v-else-if="prompt.challenge"
      :challenge="prompt.challenge"
      :label="prompt.challenge.subtype || '图形验证码'"
      :disabled="waiting"
      @done="answer('done')"
    />

    <!-- 2. 二维码。过期不自动换——换码由用户点「刷新二维码」触发，
         否则后端换了新码而界面还是旧图，用户对着旧码扫永远扫不进。 -->
    <QrVerifyCard
      v-else-if="prompt.qrCode"
      :src="prompt.qrCode"
      :disabled="waiting"
      @refresh="answer('refresh-qr')"
    />

    <!-- 3. OTP 验证码：填满自动提交 -->
    <OtpInput v-else-if="prompt.otpLength" :length="prompt.otpLength" :disabled="waiting" @submit="answer" />

    <!-- 4. 选项卡片 -->
    <ChoiceList
      v-else-if="prompt.options?.length"
      :options="prompt.options"
      :disabled="waiting"
      @choose="answer"
    />

    <!--
      5. 文本输入。

      **`inputType: 'number'` 不能直接给 `type` 属性**：Vue 3 对 `<input type="number">`
      的 `v-model` 会自动把值转成 Number，于是 `text.value` 变成数字，
      `text.trim()` / `String.prototype.trim` 立刻抛 TypeError，整个组件崩溃、弹窗 body 变空白。
      2026-11-26 用户输入第一个验证码字符时正好撞上这个。

      正确做法：`type="text"` 固定，用 **`inputmode`** 控制键盘——那才是它的用途。
      -->
    <form v-else class="field" @submit.prevent="submitText">
      <input
        :id="`prompt-${prompt.id}`"
        v-model="text"
        type="text"
        :placeholder="prompt.placeholder || ''"
        :inputmode="(prompt.inputType ?? 'text') === 'number' ? 'numeric' : 'text'"
        autocomplete="off"
        :disabled="waiting"
        required
      />
      <button type="submit" class="btn primary sm" :disabled="waiting || String(text).trim() === ''">
        {{ waiting ? '处理中…' : prompt.submitLabel || '提交' }}
      </button>
    </form>

    <!-- 短信 / 二维码 / OTP 的补充操作（换一种方式、重新推送）放底部，不抢主体 -->
    <div v-if="(prompt.sms || prompt.qrCode || prompt.otpLength) && prompt.options?.length" class="extra">
      <button
        v-for="option in prompt.options"
        :key="option.value"
        type="button"
        class="btn sm"
        :disabled="waiting"
        :title="option.hint"
        @click="answer(option.value)"
      >
        {{ option.label }}
      </button>
    </div>

    <p v-if="waiting" class="waiting">处理中…</p>
    <p v-if="error" class="error">{{ error }}</p>
  </div>
</template>

<style scoped>
.prompt {
  display: grid;
  gap: 10px;
}

.label {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--text);
}

/* 文本输入：输入框和按钮同一行，按钮不换行掉下去。 */
.field {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.field input {
  flex: 1;
  min-width: 160px;
  font: inherit;
  font-size: 13px;
  padding: 7px 10px;
  border: 1px solid var(--line);
  border-radius: 7px;
  outline: none;
  background: var(--card);
  color: var(--fg);
}

.field input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-weak);
}

/* 补充动作放底部，右对齐，不抢主体。 */
.extra {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.waiting {
  margin: 0;
  font-size: 11px;
  color: var(--muted);
}

.error {
  margin: 0;
  font-size: 12px;
  color: var(--bad);
  line-height: 1.5;
}
</style>
