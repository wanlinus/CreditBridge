<script setup lang="ts">
/**
 * 密钥页。
 *
 * ## 这一页要回答什么
 *
 * 密钥是**给程序用的凭据**，所以重点不是「管理一堆对象」，而是：
 * 现在有哪几把、分别给谁、还在不在用、要不要吊销。列表因此不显示 `id`（那是日志里的
 * 东西），显示的是**前缀 + 名字 + 最后使用时间**。
 *
 * ## 明文只出现一次（2026-11-22 起）
 *
 * 库里只存 `salt` + `hash`（scrypt），不可逆。所以：
 *   - 创建成功那一刻把明文摊开——**这是唯一需要抄走的时刻**
 *   - 列表里没有「显示」按钮，因为**真的取不回来**，不是藏起来
 *   - 忘了复制就删掉重建一把，改一处客户端配置而已
 *
 * 这段注释早先是反的（写着「现在存明文、列表里可以再展开」），而那时代码已经改成
 * 只显示一次了——注释比代码老一步，下一个读代码的人会照着注释去加一个不存在的按钮。
 *
 * ## 和浏览器登录的关系
 *
 * 两套凭据互不影响：改密码不会让 key 失效，吊销 key 也不会把浏览器踢下线。这一句要
 * 写在页面上——每次有人问「我改了密码 DSH 为什么还活着」都要重新解释一遍。
 */
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
/** 刚建好的那把：明文要摊开给用户抄走。 */
const fresh = ref<{ key: ApiKey; secret: string } | null>(null);
const freshCopied = ref(false);

/**
 * 数据变了：重拉列表 + 刷新导航条计数。
 *
 * 计数必须跟着刷新，否则新建一把 key 之后导航条还是「密钥 0」——看起来像没建成。
 */
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

    <!-- 建完立刻摊开明文：这是**唯一**能看到它的时刻，库里只有不可逆的哈希。 -->
    <div v-if="fresh" class="fresh">
      <div class="fresh-head">
        <b>已创建：{{ fresh.key.label }}</b>
        <span class="muted">把它填进 DSH 的「API key」或脚本的 <code>Authorization: Bearer</code></span>
      </div>
      <pre class="secret">{{ fresh.secret }}</pre>
      <div class="fresh-acts">
        <button type="button" class="btn sm" @click="copyFresh">{{ freshCopied ? '已复制' : '复制' }}</button>
        <button type="button" class="btn sm ghost" @click="fresh = null">收起</button>
        <!--
          这里早先写的是「忘了也没事：列表里点显示还能再看一次」——而那个按钮在
          2026-11-22 就已经删掉了（明文不再落库）。一句话说反，用户就会关掉这个框
          去列表里找，然后发现找不到、以为界面坏了。所以必须写明**真的取不回来**。
        -->
        <span class="muted small">关掉之后就取不回来了（库里只存哈希）。忘了复制就删掉重建一把。</span>
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

/* 计数跟在标题后面，别继承标题的 600 字重——否则「密钥 1 把」读起来像一个词组。 */
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
