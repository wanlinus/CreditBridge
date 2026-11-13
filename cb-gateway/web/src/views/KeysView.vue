<script setup lang="ts">
import { computed, ref } from 'vue';

import { createKey, getKeys, type ApiKey } from '@/api/keys';
import { useAsync } from '@/composables/useAsync';
import { refreshNavCounts } from '@/composables/useNavCounts';
import { copyText } from '@/utils/clipboard';
import KeyRow from '@/components/KeyRow.vue';
import { errorText } from '@/utils/error';

const state = useAsync(getKeys);

const keys = computed<ApiKey[]>(() => state.data.value?.keys ?? []);
const enabledCount = computed(() => keys.value.filter((key) => key.enabled).length);

const creating = ref(false);
const draftLabel = ref('');
const busy = ref(false);
const actionError = ref<string | null>(null);
const fresh = ref<{ key: ApiKey; secret: string } | null>(null);
const freshCopied = ref(false);

function reload(): void {
  void state.refresh();
  void refreshNavCounts();
}

async function submit(): Promise<void> {
  busy.value = true;
  actionError.value = null;
  try {
    const created = await createKey(draftLabel.value.trim());
    fresh.value = created;
    freshCopied.value = false;
    draftLabel.value = '';
    creating.value = false;
    reload();
  } catch (error) {
    actionError.value = errorText(error);
  } finally {
    busy.value = false;
  }
}

async function copyFresh(): Promise<void> {
  if (!fresh.value) return;
  const ok = await copyText(fresh.value.secret);
  if (!ok) {
    actionError.value = '复制失败：浏览器不允许。手动选中那行明文复制。';
    return;
  }
  freshCopied.value = true;
}

const error = computed(() => actionError.value || state.error.value);
const loading = computed(() => state.loading.value);
</script>

<template>
  <div>
    <p v-if="error" class="alert bad">
      <span>{{ error }}</span>
      <button type="button" class="btn sm" @click="actionError = null">知道了</button>
    </p>

    <div class="toolbar">
      <button type="button" class="btn primary" @click="creating = !creating">
        {{ creating ? '收起' : '+ 新建密钥' }}
      </button>
      <span class="grow" />
      <button type="button" class="btn ghost sm" :disabled="loading" @click="state.refresh()">
        {{ loading ? '读取中…' : '刷新' }}
      </button>
    </div>

    <div v-if="creating" class="panel">
      <input
        v-model="draftLabel"
        class="field"
        maxlength="60"
        placeholder="给这把起个名字，例如「DSH 笔记本」"
        aria-label="密钥名字"
        @keydown.enter="submit"
      />
      <button type="button" class="btn primary" :disabled="busy || draftLabel.trim() === ''" @click="submit">
        创建
      </button>
      <button type="button" class="btn ghost" :disabled="busy" @click="creating = false">取消</button>
    </div>

    <div v-if="fresh" class="fresh">
      <div class="fresh-head">
        <b>已创建：{{ fresh.key.label }}</b>
        <span class="muted">把它填进 DSH 的「API key」或脚本的 <code>Authorization: Bearer</code></span>
      </div>
      <pre class="secret">{{ fresh.secret }}</pre>
      <div class="fresh-acts">
        <button type="button" class="btn sm" @click="copyFresh">{{ freshCopied ? '已复制' : '复制' }}</button>
        <button type="button" class="btn sm ghost" @click="fresh = null">收起</button>
        <span class="muted small">忘了也没事：列表里点「显示」还能再看一次。</span>
      </div>
    </div>

    <section class="card">
      <div class="title">
        密钥
        <span class="count">
          {{ keys.length }} 把<template v-if="enabledCount !== keys.length">（{{ enabledCount }} 把启用中）</template>
        </span>
      </div>
      <div class="body flush">
        <KeyRow v-for="item in keys" :key="item.id" :item="item" @changed="reload" />
        <p v-if="keys.length === 0 && !loading" class="empty">
          还没有密钥。没有它，DSH 和脚本就只能靠浏览器会话——而那本来不是给程序用的。
        </p>
      </div>
    </section>

    <p class="foot">
      用法：请求头 <code>Authorization: Bearer sk-…</code>。浏览器会话和 API key 是
      <b>两套独立凭据</b>：改密码不会让 key 失效，吊销一把 key 也不会把你踢下线。
      <template v-if="keys.length">当前 {{ keys.length }} 把，停用的那把用它发请求会 401。</template>
    </p>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.panel {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 12px 14px;
  margin-bottom: 14px;
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  background: var(--accent-weak);
}

.field {
  font: inherit;
  font-size: 13px;
  padding: 6px 10px;
  border: 1px solid var(--line);
  border-radius: 7px;
  outline: none;
  flex: 1;
  min-width: 220px;
  background: var(--card);
}

.field:focus {
  border-color: var(--accent);
}

.fresh {
  padding: 12px 14px;
  margin-bottom: 14px;
  border: 1px solid var(--ok);
  border-left-width: 3px;
  border-radius: var(--radius);
  background: var(--ok-bg);
}

.fresh-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 13px;
  color: var(--fg);
}

.secret {
  margin: 10px 0 8px;
  padding: 8px 10px;
  background: var(--card);
  border: 1px dashed var(--line);
  border-radius: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  word-break: break-all;
  white-space: pre-wrap;
  user-select: all;
}

.fresh-acts {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.alert span {
  flex: 1;
  min-width: 240px;
}

.count {
  font-size: 12px;
  font-weight: 400;
  color: var(--muted);
}

.empty {
  margin: 12px 16px;
  color: var(--muted);
  font-size: 13px;
}

.foot {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.9;
  margin: 4px 0 0;
}
</style>
