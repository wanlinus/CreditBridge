<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';

import { deleteKey, updateKey, type ApiKey } from '@/api/keys';
import { useFlash } from '@/composables/useFlash';
import { useInlineRename } from '@/composables/useInlineRename';
import { copyText } from '@/utils/clipboard';
import { fmtAgo, fmtTime } from '@/utils/format';
import ToneBadge from '@/components/ToneBadge.vue';
import { errorText } from '@/utils/error';

const props = defineProps<{ item: ApiKey }>();
const emit = defineEmits<{ (e: 'changed'): void }>();

const revealed = ref(false);
const secretEl = ref<HTMLElement | null>(null);
const copied = ref(false);
const busy = ref(false);
const confirming = ref(false);
const { flash, say } = useFlash();

let copyTimer: ReturnType<typeof setTimeout> | null = null;

onBeforeUnmount(() => {
  if (copyTimer) clearTimeout(copyTimer);
});

const usedText = computed(() => (props.item.lastUsedAt ? `${fmtAgo(props.item.lastUsedAt)}用过` : '从未使用'));

const rename = useInlineRename({
  value: () => props.item.label,
  save: async (next) => {
    busy.value = true;
    try {
      await updateKey(props.item.id, { label: next });
      emit('changed');
      say('名字已保存');
    } catch (error) {
      say(errorText(error), 'bad');
    } finally {
      busy.value = false;
    }
  },
});
const { editing, draft, cancel: cancelEdit, start: startEdit, commit: saveLabel } = rename;

async function copy(): Promise<void> {
  const text = props.item.secret;
  if (!text) return;
  const ok = await copyText(text);
  if (!ok) {
    revealed.value = true;
    await nextTick();
    const node = secretEl.value;
    if (node) {
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    say('浏览器不允许自动复制，已帮你选中——按 Ctrl+C 即可。', 'bad');
    return;
  }
  doneCopy();
}

function doneCopy(): void {
  copied.value = true;
  if (copyTimer) clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    copied.value = false;
    copyTimer = null;
  }, 1600);
}

async function toggleEnabled(): Promise<void> {
  busy.value = true;
  try {
    await updateKey(props.item.id, { enabled: !props.item.enabled });
    emit('changed');
    say(props.item.enabled ? '已停用：用它发的请求现在会 401' : '已启用：客户端可以继续用这把');
  } catch (error) {
    say(errorText(error), 'bad');
  } finally {
    busy.value = false;
  }
}

async function remove(): Promise<void> {
  busy.value = true;
  try {
    await deleteKey(props.item.id);
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
  <div class="row" :class="{ off: !item.enabled }">
    <div class="main">
      <code class="prefix">{{ item.prefix }}…</code>
      <ToneBadge :tone="item.enabled ? 'ok' : 'muted'" :label="item.enabled ? '启用中' : '已停用'" />

      <input
        v-if="editing"
        :ref="rename.inputEl"
        v-model="draft"
        class="rename"
        maxlength="60"
        aria-label="密钥名字"
        @keydown.enter="saveLabel"
        @keydown.esc="cancelEdit"
        @blur="editing = false"
      />
      <button v-else type="button" class="name" title="点击改名" @click="startEdit">{{ item.label }}</button>

      <span class="meta">
        建于 {{ fmtTime(item.createdAt) }} ·
        <span :class="{ never: !item.lastUsedAt }">{{ usedText }}</span>
      </span>

      <span class="grow" />

      <div class="acts">
        <button v-if="item.secret" type="button" class="btn sm" @click="revealed = !revealed">
          {{ revealed ? '隐藏' : '显示' }}
        </button>
        <button v-if="item.secret" type="button" class="btn sm" @click="copy">{{ copied ? '已复制' : '复制' }}</button>
        <button type="button" class="btn sm" :disabled="busy" @click="toggleEnabled">
          {{ item.enabled ? '停用' : '启用' }}
        </button>
        <button type="button" class="btn sm danger" :disabled="busy" @click="confirming = true">删除</button>
      </div>
    </div>

    <pre v-if="revealed && item.secret" ref="secretEl" class="secret">{{ item.secret }}</pre>

    <p v-if="!item.secret" class="hint">
      这把是 2026-11-11 之前建的，<code>keys.json</code> 里只存了哈希，原文不可恢复。
      要能复制就得重建一把——建完记得逐个改客户端配置。
    </p>

    <div v-if="confirming" class="confirm">
      <span>
        删除 <code>{{ item.prefix }}…</code>？用它发请求的客户端（DSH、脚本）会<b>立刻 401</b>，
        而且这把的明文再也找不回来。
      </span>
      <button type="button" class="btn sm" :disabled="busy" @click="confirming = false">取消</button>
      <button type="button" class="btn sm danger" :disabled="busy" @click="remove">确认删除</button>
    </div>

    <p v-if="flash" class="flash" :class="flash.tone">{{ flash.text }}</p>
  </div>
</template>

<style scoped>
.row {
  padding: 8px 12px;
  border-radius: 8px;
}

.row:hover {
  background: var(--hover);
}

.row.off {
  opacity: 0.72;
}

.main {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
}

.prefix {
  font-size: 12px;
  min-width: 96px;
}

.name {
  border: 0;
  background: transparent;
  font: inherit;
  color: var(--fg);
  padding: 1px 4px;
  border-radius: 5px;
  cursor: text;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.name:hover {
  background: var(--card2);
}

.rename {
  font: inherit;
  font-size: 13px;
  border: 1px solid var(--accent);
  border-radius: 5px;
  padding: 1px 5px;
  width: 180px;
  outline: none;
}

.rename:focus {
  box-shadow: 0 0 0 3px var(--accent-weak);
}

.meta {
  color: var(--muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.meta .never {
  font-style: italic;
  opacity: 0.85;
}

.acts {
  display: inline-flex;
  gap: 4px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.secret {
  margin: 8px 0 2px;
  padding: 8px 10px;
  background: var(--card2);
  border: 1px dashed var(--line);
  border-radius: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  word-break: break-all;
  white-space: pre-wrap;
  user-select: all;
}

.hint {
  margin: 6px 0 2px;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.7;
}

.confirm {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--bad-bg);
  color: var(--bad);
  font-size: 12px;
}

.flash {
  margin: 6px 0 2px;
  font-size: 12px;
}

.flash.ok {
  color: var(--ok);
}

.flash.bad {
  color: var(--bad);
}
</style>
