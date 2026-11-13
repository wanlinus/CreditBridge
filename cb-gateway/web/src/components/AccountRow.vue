<script setup lang="ts">
import { computed, ref } from 'vue';

import {
  deleteAccount,
  logoutAccount,
  patchAccount,
  rotateDevice,
  type AccountRow,
  type ChannelCapability,
} from '@/api/accounts';
import { useAccountActions } from '@/composables/useAccountActions';
import { useFlash } from '@/composables/useFlash';
import { useInlineRename } from '@/composables/useInlineRename';
import { upstreamIdentity } from '@/utils/account';
import { fmtNum, fmtTokens } from '@/utils/format';
import StatusBadge from '@/components/StatusBadge.vue';
import { errorText } from '@/utils/error';

const props = defineProps<{
  account: AccountRow;
  channel: ChannelCapability;
}>();

const emit = defineEmits<{
  (e: 'changed'): void;
  (e: 'login'): void;
}>();

const open = ref(false);
const confirming = ref(false);
const { flash, say } = useFlash();

const upstreamText = computed(() => upstreamIdentity(props.account.profile, props.account.label));

const hasHint = computed(() => props.channel.canLogin || props.channel.canLogout || props.channel.canRotateDevice);

const rename = useInlineRename({
  value: () => props.account.label,
  save: async (next) => {
    busy.value = true;
    try {
      await patchAccount(props.account.id, { label: next });
      emit('changed');
      say('显示名已保存');
    } catch (error) {
      say(errorText(error), 'bad');
    } finally {
      busy.value = false;
    }
  },
});
const { editing, draft, cancel: cancelEdit, start: startEdit, commit: saveLabel } = rename;

const actions = useAccountActions({
  account: computed(() => props.account),
  onChanged: () => emit('changed'),
  onSay: say,
});
const { busy, verify, toggle } = actions;

async function logout(): Promise<void> {
  busy.value = true;
  try {
    const result = await logoutAccount(props.account.id);
    emit('changed');
    say(result.upstream ? `本地会话已清；上游拒绝退出：${result.upstream}` : '已让上游注销这条会话', result.upstream ? 'bad' : 'ok');
  } catch (error) {
    say(errorText(error), 'bad');
  } finally {
    busy.value = false;
  }
}

async function rotate(): Promise<void> {
  busy.value = true;
  try {
    const result = await rotateDevice(props.account.id);
    emit('changed');
    say(result.changed ? '设备号已换成独立的一份' : result.reason || '没有可换的字段', result.changed ? 'ok' : 'bad');
  } catch (error) {
    say(errorText(error), 'bad');
  } finally {
    busy.value = false;
  }
}

async function remove(): Promise<void> {
  busy.value = true;
  try {
    await deleteAccount(props.account.id);
    emit('changed');
  } catch (error) {
    say(errorText(error), 'bad');
    confirming.value = false;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="row" :class="{ faded: account.status === 'disabled' }">
    <div class="main">
      <router-link class="aid" :to="`/accounts/${encodeURIComponent(account.id)}`">{{ account.id }}</router-link>

      <input
        v-if="editing"
        :ref="rename.inputEl"
        v-model="draft"
        class="rename"
        maxlength="40"
        aria-label="显示名"
        @keydown.enter="saveLabel"
        @keydown.esc="cancelEdit"
        @blur="cancelEdit"
      />
      <button v-else type="button" class="name" :class="{ unnamed: !account.label }" title="点击改名" @click="startEdit">
        {{ account.label || '未命名' }}
      </button>

      <span v-if="upstreamText" class="upstream" :title="`上游身份：${upstreamText}`">{{ upstreamText }}</span>
      <StatusBadge :status="account.status" :cooldown-until="account.cooldownUntil" :title="account.statusMessage" />

      <span class="grow" />

      <span class="cell"><i>余额</i>{{ typeof account.totalRemain === 'number' ? fmtNum(account.totalRemain) : '—' }}</span>
      <span class="cell"><i>今日</i>{{ fmtTokens(account.todayTokens) }}</span>

      <div class="acts">
        <button
          v-if="channel.canVerify && account.status !== 'disabled'"
          type="button"
          class="btn sm"
          :disabled="busy"
          @click="verify"
        >
          检测
        </button>
        <button type="button" class="btn sm" :disabled="busy" @click="toggle">
          {{ account.status === 'disabled' ? '启用' : '停用' }}
        </button>
        <button
          type="button"
          class="btn sm ghost"
          :aria-expanded="open"
          @click="open = !open; confirming = false"
        >
          {{ open ? '收起' : '更多' }}
        </button>
      </div>
    </div>

    <div v-if="open" class="more">
      <button v-if="channel.canLogin" type="button" class="btn sm" @click="emit('login')">重新登录</button>
      <button v-if="channel.canLogout" type="button" class="btn sm" :disabled="busy" @click="logout">上游退出</button>
      <button v-if="channel.canRotateDevice" type="button" class="btn sm" :disabled="busy" @click="rotate">换设备号</button>
      <span class="grow" />
      <button type="button" class="btn sm danger" :disabled="busy" @click="confirming = true">删除账号</button>
    </div>

    <p v-if="open && !confirming && hasHint" class="hint">
      <template v-if="channel.canLogin">重新登录会用同一个上游账号再走一遍授权，会重新覆盖这个号的凭据。</template>
      <template v-if="channel.canLogout">上游退出只注销会话，账号和凭据都留着。</template>
      <template v-if="channel.canRotateDevice">
        换设备号只影响这个号——<b>签到报 9074 是上游瞬时爆满，换设备号解决不了</b>。
      </template>
    </p>

    <div v-if="confirming" class="confirm">
      <span>
        删除 <code>{{ account.id }}</code>？它名下的 <code>{{ account.idPrefix }}-{{ account.seq }}/…</code>
        这批模型 id 会从模型列表里消失，DSH 里要重新「获取可用模型」。不可撤销。
      </span>
      <button type="button" class="btn sm" :disabled="busy" @click="confirming = false">取消</button>
      <button type="button" class="btn sm danger" :disabled="busy" @click="remove">确认删除</button>
    </div>

    <p v-if="flash" class="flash" :class="flash.tone">{{ flash.text }}</p>
  </div>
</template>

<style scoped>
.row {
  padding: 4px 4px 4px 24px;
  border-radius: 8px;
}

.row:hover {
  background: var(--hover);
}

.row.faded .aid,
.row.faded .name {
  opacity: 0.6;
}

.main {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 4px 0;
  font-size: 13px;
}

.aid {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  min-width: 44px;
}

.name {
  border: 0;
  background: transparent;
  font: inherit;
  color: var(--muted);
  padding: 1px 4px;
  border-radius: 5px;
  cursor: text;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.name:hover {
  background: var(--card2);
  color: var(--fg);
}

.name.unnamed {
  color: var(--muted);
  font-style: italic;
}

.rename {
  font: inherit;
  font-size: 13px;
  color: var(--fg);
  border: 1px solid var(--accent);
  border-radius: 5px;
  padding: 1px 5px;
  width: 160px;
  outline: none;
}

.rename:focus {
  box-shadow: 0 0 0 3px var(--accent-weak);
}

.upstream {
  color: var(--muted);
  font-size: 11px;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cell {
  color: var(--muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  min-width: 76px;
  text-align: right;
  white-space: nowrap;
}

.cell i {
  font-style: normal;
  opacity: 0.7;
  margin-right: 4px;
}

.acts {
  display: inline-flex;
  gap: 4px;
  min-width: 140px;
  justify-content: flex-end;
}

.more {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 6px 0 2px;
  border-top: 1px dashed var(--line);
  margin-top: 2px;
}

.hint {
  margin: 4px 0 2px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.7;
}

.hint b {
  color: var(--warn);
  font-weight: 600;
}

.confirm {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 6px 0 2px;
  padding: 8px 10px;
  background: var(--bad-bg);
  border-radius: 8px;
  font-size: 12px;
  color: var(--bad);
}

.confirm .grow {
  flex: 1;
}

.flash {
  margin: 4px 0 2px;
  font-size: 12px;
}

.flash.ok {
  color: var(--ok);
}

.flash.bad {
  color: var(--bad);
}
</style>
