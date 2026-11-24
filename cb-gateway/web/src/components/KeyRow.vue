<script setup lang="ts">
/**
 * 密钥列表的一行。
 *
 * ## 这一行想回答的问题
 *
 * 不是「它有哪些字段」，而是三个运维时真会问的：
 *   ① 这把还在用吗 —— `最后使用 3 分钟前` / `从未使用`
 *   ② 停掉它会怎样 —— 行内直接写「用它发的请求会 401」
 *   ③ 我还能看到原文吗 —— **不能**，只有 `sk-` + 9 位前缀
 *
 * ## 为什么不显示明文
 *
 * 2026-11-22 起明文不落库（`api_key.secret` 列已物理删除），库里只有
 * `salt` + `hash`（scrypt），不可逆。所以这一行没有任何「显示/复制」按钮——
 * 那不是藏起来，是**真的取不出来**。
 *
 * 明文只在创建成功的那一刻由 `KeysView` 展示一次。忘了复制就删掉重建一把，
 * 改一处客户端配置而已。这个取舍换来的是：**库泄露不等于 key 泄露**。
 */
import { computed, ref } from 'vue';

import { deleteKey, updateKey, type ApiKey } from '@/api/keys';
import { useFlash } from '@/composables/useFlash';
import { useInlineRename } from '@/composables/useInlineRename';
import { fmtAgo, fmtTime } from '@/utils/format';
import ToneBadge from '@/components/ToneBadge.vue';
import { errorText } from '@/utils/error';

const props = defineProps<{ item: ApiKey }>();
const emit = defineEmits<{ (e: 'changed'): void }>();

const busy = ref(false);
const confirming = ref(false);
const { flash, say } = useFlash();

/** 最后使用时间的人话。从未用过要单独说，不然会显示成 1970。 */
const usedText = computed(() => (props.item.lastUsedAt ? `最后使用 ${fmtAgo(props.item.lastUsedAt)}` : '从未使用'));

/* ------------------------------ 改名 ------------------------------ */

const rename = useInlineRename({
  value: () => props.item.label,
  async save(next: string) {
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

/* ------------------------------ 停用 / 删除 ------------------------------ */

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
    // 说一句话会跟着这一行一起消失，不 say。
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
        <button type="button" class="btn sm" :disabled="busy" @click="toggleEnabled">
          {{ item.enabled ? '停用' : '启用' }}
        </button>
        <button type="button" class="btn sm danger" :disabled="busy" @click="confirming = true">删除</button>
      </div>
    </div>

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
}

.prefix {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
}

.name {
  background: none;
  border: none;
  padding: 2px 4px;
  color: inherit;
  font: inherit;
  cursor: pointer;
  border-radius: 4px;
}

.name:hover {
  background: var(--hover);
  text-decoration: underline dotted;
}

.rename {
  width: 160px;
  padding: 2px 6px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--card);
  color: inherit;
  font: inherit;
}

.meta {
  color: var(--muted);
  font-size: 12px;
}

.never {
  opacity: 0.8;
}

.grow {
  flex: 1;
}

.acts {
  display: flex;
  gap: 6px;
}

.confirm {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--bad-bg);
  font-size: 13px;
}

.flash {
  margin: 6px 0 0;
  font-size: 12px;
}

.flash.ok {
  color: var(--ok);
}

.flash.bad {
  color: var(--bad);
}
</style>
