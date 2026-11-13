<script setup lang="ts">
import { computed, ref } from 'vue';

import type { AccountRow, ChannelCapability } from '@/api/accounts';
import type { ChannelAppearance } from '@/api/channels';
import { canAddAccount } from '@/utils/account';
import ChannelIcon from '@/components/ChannelIcon.vue';

const props = defineProps<{
  channels: ChannelCapability[];
  accounts: AccountRow[];
  looks: Map<string, ChannelAppearance>;
}>();

const emit = defineEmits<{
  (e: 'start', channelId: string): void;
  (e: 'close'): void;
}>();

const countOf = (channelId: string) => props.accounts.filter((account) => account.channelId === channelId).length;

const blocked = (channel: ChannelCapability) => !canAddAccount(channel, props.accounts);

const options = computed(() => props.channels.filter((channel) => channel.canLogin));

const selected = ref<string>(options.value.find((channel) => !blocked(channel))?.id ?? '');

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
      <span class="muted">选一个平台，会打开新标签页去授权</span>
      <span class="grow" />
      <button type="button" class="btn sm ghost" @click="emit('close')">取消</button>
    </div>

    <div v-if="options.length === 0" class="empty">没有支持自助登录的通道。</div>

    <div v-else class="options" role="radiogroup" aria-label="平台">
      <label v-for="channel in options" :key="channel.id" class="opt" :class="{ off: blocked(channel) }">
        <input v-model="selected" type="radio" name="channel" :value="channel.id" :disabled="blocked(channel)" />
        <ChannelIcon
          :icon="looks.get(channel.id)?.icon ?? null"
          :letter="looks.get(channel.id)?.letter ?? channel.label.slice(0, 1)"
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
