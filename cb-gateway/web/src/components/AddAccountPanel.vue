<script setup lang="ts">
/**
 * 「添加账号」面板：先选平台，再起登录。
 *
 * 旧页面把这个动作放在页面顶部一个按钮里，展开后是一排 radio。这里保留「先选平台」的顺序，
 * 但把**为什么某个平台点不了**写在选项上——单账号通道已经有号时它是灰的，而用户此刻想的
 * 往往是「我想换号」，提示必须直接告诉他用那一行的「重新登录」。
 *
 * 面板本身不发请求：起任务由父组件做，因为「开空白窗」要发生在点击事件的同一轮里
 * （弹窗拦截），那件事必须在最外层做。
 */
import { computed, ref } from 'vue';

import type { AccountRow, ChannelCapability } from '@/api/accounts';
import type { ChannelLook } from '@/api/channels';
import { canAddAccount } from '@/utils/account';
import ChannelIcon from '@/components/ChannelIcon.vue';

const props = defineProps<{
  channels: ChannelCapability[];
  accounts: AccountRow[];
  /**
   * 「通道 id + 显示名 → 图标/兜底字母」。由 `api/channels.ts` 的 `looksOf()` 造，
   * **不要在这里自己拼兜底链**——三处各写一遍的话，漏一段就是静默留白。
   */
  look: (channelId: string, label: string) => ChannelLook;
}>();

const emit = defineEmits<{
  (e: 'start', channelId: string): void;
  (e: 'close'): void;
}>();

const countOf = (channelId: string) => props.accounts.filter((account) => account.channelId === channelId).length;

/**
 * 单账号通道已经有号 = 加不了。规则和账号页标题条共用一份（`canAddAccount`）——
 * 两处各写一遍会出现「标题条上没有 + 添加，面板里那个选项却可点」。
 */
const blocked = (channel: ChannelCapability) => !canAddAccount(channel, props.accounts);

const options = computed(() => props.channels.filter((channel) => channel.canLogin));

const selected = ref<string>(options.value.find((channel) => !blocked(channel))?.id ?? '');

/**
 * 顶栏提示。**按选中通道自述的 `opensWindow` 说话**：
 * URL 式登录会开新标签页去授权，表单式（短信/cookie）不会——提示必须跟得上，
 * 否则用户点完发现没开窗会以为坏了。
 */
const hintText = computed(() => {
  const channel = options.value.find((item) => item.id === selected.value);
  if (channel?.opensWindow === false) return '选一个平台，会在弹窗里完成登录';
  return '选一个平台，会打开新标签页去授权';
});

function hint(channel: ChannelCapability): string {
  if (blocked(channel)) return `只支持一个账号，已有 ${countOf(channel.id)} 个；换号用那行的「重新登录」`;
  if (!channel.multiAccount) return '只支持一个账号';
  return `${countOf(channel.id)} 个账号`;
}
</script>

<template>
  <div class="panel add-account">
    <div class="head">
      <span class="title">添加账号</span>
      <span class="muted">{{ hintText }}</span>
      <span class="grow" />
      <button type="button" class="btn sm ghost" @click="emit('close')">取消</button>
    </div>

    <div v-if="options.length === 0" class="empty">没有支持自助登录的通道。</div>

    <div v-else class="options" role="radiogroup" aria-label="平台">
      <label v-for="channel in options" :key="channel.id" class="opt" :class="{ off: blocked(channel) }">
        <input v-model="selected" type="radio" name="channel" :value="channel.id" :disabled="blocked(channel)" />
        <ChannelIcon
          :icon="look(channel.id, channel.label).icon"
          :letter="look(channel.id, channel.label).letter"
          :size="16"
          :alt="channel.label"
        />
        <span class="name">{{ channel.label }}</span>
        <span class="tag">{{ hint(channel) }}</span>
      </label>
    </div>

    <div class="foot">
      <button type="button" class="btn primary" :disabled="!selected" @click="emit('start', selected)">
        确认登录
      </button>
      <span class="muted small">
        授权完成后这个号会自动出现在列表里；中途可以取消，最长等 5 分钟。
      </span>
    </div>
  </div>
</template>

<style scoped>
.panel {
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  background: var(--accent-weak);
  padding: 12px 14px;
  margin-bottom: 16px;
}

.head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.title {
  font-weight: 600;
  font-size: 13px;
}

.options {
  display: grid;
  gap: 6px;
}

.opt {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
}

.opt:has(input:checked) {
  border-color: var(--accent);
}

.opt.off {
  opacity: 0.55;
  cursor: not-allowed;
}

.name {
  font-weight: 500;
}

.tag {
  margin-left: auto;
  color: var(--muted);
  font-size: 11px;
}

.foot {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 10px;
}

.empty {
  color: var(--muted);
  font-size: 13px;
}
</style>
