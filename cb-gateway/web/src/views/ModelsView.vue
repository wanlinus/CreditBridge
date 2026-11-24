<script setup lang="ts">
/**
 * 模型可见性。
 *
 * ## 这一页改的是「DSH 能看见什么」
 *
 * 目录（上游实际给的）和可见性（愿意暴露哪些）是两件事。这里只改后者：关掉的模型不会
 * 出现在 `/v1/models` 里，DSH 下一次同步（15 秒）就看不到了。
 *
 * ## 为什么点一下就存，没有「保存」按钮
 *
 * 每个勾选是一个独立决定，攒着一起存会带来两个问题：忘记点保存（改了但没生效）、
 * 以及「保存」按钮该不该禁用（改了一半的状态算什么）。代价是请求多——本地网关，
 * 一次几毫秒，值得。
 *
 * 失败时**以服务端为准重新拉**，不做乐观回滚代码：回滚要记住「改之前是什么」，
 * 而重拉一行就能保证界面和 `config.json` 一致。
 */
import { computed, ref, watch } from 'vue';

import { getCatalog, saveModelSetting, saveVisibility, type ChannelCatalog } from '@/api/models';
import { getChannels, looksOf } from '@/api/channels';
import { useAsync } from '@/composables/useAsync';
import { useFlash } from '@/composables/useFlash';
import { errorText } from '@/utils/error';
import ChannelIcon from '@/components/ChannelIcon.vue';
import ToggleSwitch from '@/components/ToggleSwitch.vue';

const state = useAsync(getCatalog);
const channelsState = useAsync(getChannels);

/** 本地副本：勾选先改这里（立刻有反馈），再发请求。 */
const groups = ref<ChannelCatalog[]>([]);
watch(
  () => state.data.value,
  (value) => {
    groups.value = (value?.channels ?? []).map((item) => ({
      ...item,
      models: [...item.models],
      visible: item.visible ? [...item.visible] : null,
    }));
  },
  { immediate: true },
);

const looks = computed(() => looksOf(channelsState.data.value?.channels));

const busyPrefix = ref<string | null>(null);
const { flash, say } = useFlash();

/** 某个模型现在勾没勾上。`visible: null` = 全部显示。 */
function isChecked(group: ChannelCatalog, modelId: string): boolean {
  return group.visible === null ? true : group.visible.includes(modelId);
}

/**
 * 卡头那个开关是**看图的姿势**，不是「全选/全不选」：
 * 打开 = 只列已勾选的，关掉 = 列全部（默认）。
 *
 * 做成纯前端过滤而不是发请求：它不改变任何状态，切来切去零成本；写成
 * `visible: []` 那种"全不选"会把服务端的限制也清掉——那是两件完全不同的事。
 */
const onlyChecked = ref(false);

/** 勾选一个模型：立刻改本地、再存「当前勾上的那一批」。 */
async function toggleModel(group: ChannelCatalog, modelId: string): Promise<void> {
  const next = new Set(group.visible === null ? group.models.map((model) => model.id) : group.visible);
  if (next.has(modelId)) next.delete(modelId);
  else next.add(modelId);

  group.visible = [...next];
  busyPrefix.value = group.idPrefix;
  try {
    await saveVisibility({ prefix: group.idPrefix, visible: group.visible });
    say(`${group.label}：已保存 ${group.visible.length} 个模型`);
  } catch (error) {
    say(errorText(error), 'bad');
    void state.refresh();
  } finally {
    busyPrefix.value = null;
  }
}

/** 通道总闸：关掉后这个通道的模型整体不出现在 `/v1/models`。 */
async function toggleList(group: ChannelCatalog): Promise<void> {
  const next = !group.listed;
  busyPrefix.value = group.idPrefix;
  try {
    await saveVisibility({ prefix: group.idPrefix, action: 'toggle-list', listed: next });
    group.listed = next;
    say(next ? `${group.label}：已加入模型列表` : `${group.label}：已从模型列表移除`, next ? 'ok' : 'bad');
  } catch (error) {
    say(errorText(error), 'bad');
    void state.refresh();
  } finally {
    busyPrefix.value = null;
  }
}

/** 勾选状态的一句话摘要，放在标题条右边。 */
function summary(group: ChannelCatalog): string {
  if (!group.listed) return '列表已关';
  if (group.visible === null) return '全部显示';
  return `只显示 ${group.visible.length}/${group.models.length}`;
}

/* ------------------------------ 模型设置 ------------------------------ */

/** 1000000 -> "1M"，192000 -> "192K"。上下文窗口的数字太大，原样印出来读不出量级。 */
function fmtSize(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (n >= 1000000) {
    const millions = n / 1000000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/** 输入模态：`['text','image']` → 「文本 + 图片」。 */
function inputLabel(input: string[] | null | undefined): string {
  if (!Array.isArray(input) || input.length === 0) return '—';
  const names = input.map((item) => (item === 'image' ? '图片' : item === 'text' ? '文本' : item));
  return names.join(' + ');
}

/**
 * 上下文窗口默认值的文案。
 *
 * **「上游没报」和「上游只有这么大」是两件事**：前者的数字是网关的默认值（`config`
 * 里的 `defaultContextWindow`），标成「最大」会让人以为可以放心放到那个数，而实际上
 * 可能放不了。Qoder 的 Auto / Fast 就是这种。
 */
function contextHint(model: ChannelCatalog['models'][number]): string {
  const size = fmtSize(model.effectiveContextWindow);
  return model.contextLengthEstimated ? `默认 ${size}（上游未报）` : `默认（最大 ${size}）`;
}

/**
 * 存一个模型的设置。
 *
 * 失败时**以服务端为准重新拉**，不做乐观回滚：回滚要记住「改之前是什么」，
 * 而重拉一行就能保证界面和 `config.json` 一致（和可见性那一套同一个理由）。
 */
async function patchModel(
  group: ChannelCatalog,
  model: ChannelCatalog['models'][number],
  patch: { contextWindow?: number | null; reasoningEffort?: string | null },
): Promise<void> {
  busyPrefix.value = group.idPrefix;
  try {
    const result = await saveModelSetting({ prefix: group.idPrefix, modelId: model.id, ...patch });
    model.setting = result.setting;
    say(`${model.id}：已保存`);
    // 生效档依赖档位表推导，改完得让服务端重算一遍
    void state.refresh();
  } catch (error) {
    say(errorText(error), 'bad');
    void state.refresh();
  } finally {
    busyPrefix.value = null;
  }
}

/** 上下文窗口下拉/输入框的取值：空串 = 恢复默认。 */
function onContextChange(group: ChannelCatalog, model: ChannelCatalog['models'][number], raw: string): void {
  const value = raw === '' ? null : Number(raw);
  if (value !== null && !Number.isFinite(value)) return;
  void patchModel(group, model, { contextWindow: value });
}

/** 思考强度下拉：空串 = 跟随默认（档位表里最高那一档）。 */
function onEffortChange(group: ChannelCatalog, model: ChannelCatalog['models'][number], raw: string): void {
  void patchModel(group, model, { reasoningEffort: raw === '' ? null : raw });
}

/** 当前页要显示哪些模型：默认全部，开了「只看已选」就只留勾上的。 */
const shownModels = computed(() => {
  const group = activeGroup.value;
  if (!group) return [];
  if (!onlyChecked.value) return group.models;
  return group.models.filter((model) => isChecked(group, model.id));
});

const error = computed(() => state.error.value || channelsState.error.value);

/**
 * 一个通道一个标签页。
 *
 * 平铺四张卡的时候整页 60 行、两千多像素高，切到「Trae 的那个模型」要滚很久；而实际
 * 操作永远是「先想清楚是哪个通道，再找模型」。标签页把这一步显式化，同一时刻只看一家。
 *
 * 标签用 `idPrefix` 做键（不是数组下标）：`groups` 每次刷新都会重建，下标会漂。
 */
const activeTab = ref<string>('');

/** 标签栏的数据：图标、名字、模型数、总闸状态。 */
const tabs = computed(() =>
  groups.value.map((group) => ({
    idPrefix: group.idPrefix,
    channelId: group.channelId,
    label: group.label,
    count: group.models.length,
    listed: group.listed,
    /** 有模型被关掉时用「显示 n/总数」，让切页之前就知道这一家被裁剪过。 */
    hidden: group.visible === null ? 0 : Math.max(0, group.models.length - group.visible.length),
  })),
);

/** 当前页；刷新后原来的通道没了（理论上不会）就退回第一个。 */
const activeGroup = computed(() => {
  const hit = groups.value.find((group) => group.idPrefix === activeTab.value);
  return hit ?? groups.value[0] ?? null;
});

// 首屏或通道增减时把选中项拉回一个合法的值。
watch(
  () => groups.value.map((group) => group.idPrefix).join(','),
  () => {
    if (!groups.value.some((group) => group.idPrefix === activeTab.value)) {
      activeTab.value = groups.value[0]?.idPrefix ?? '';
    }
  },
  { immediate: true },
);
</script>

<template>
  <div>
    <p v-if="error" class="alert bad">{{ error }}</p>
    <p v-if="flash" class="flash" :class="flash.tone">{{ flash.text }}</p>

    <p class="intro">
      关掉的模型不会出现在 <code>/v1/models</code> 里，DSH 下一次同步（15 秒）就看不到了。
      改动点一下立即保存——这一页没有「保存」按钮。
    </p>

    <!--
      标签页：一个通道一页。平铺四张卡是 60 行、两千多像素，而实际操作总是
      「先定通道再找模型」，所以这里把通道做成页签，同一时刻只看一家。
    -->
    <div class="tabs" role="tablist" aria-label="通道">
      <button
        v-for="tab in tabs"
        :key="tab.idPrefix"
        type="button"
        role="tab"
        class="tab"
        :class="{ on: tab.idPrefix === activeGroup?.idPrefix, off: !tab.listed }"
        :aria-selected="tab.idPrefix === activeGroup?.idPrefix"
        :title="tab.listed ? undefined : '这个通道的模型已从 /v1/models 移除'"
        @click="activeTab = tab.idPrefix"
      >
        <ChannelIcon
          :icon="looks(tab.channelId, tab.label).icon"
          :letter="looks(tab.channelId, tab.label).letter"
          :size="14"
          :alt="tab.label"
        />
        <span>{{ tab.label }}</span>
        <span class="count">{{ tab.hidden ? `${tab.count - tab.hidden}/${tab.count}` : tab.count }}</span>
      </button>
    </div>

    <section v-if="activeGroup" :key="activeGroup.idPrefix" class="card">
      <div class="title">
        <ChannelIcon
          :icon="looks(activeGroup.channelId, activeGroup.label).icon"
          :letter="looks(activeGroup.channelId, activeGroup.label).letter"
          :size="18"
          :alt="activeGroup.label"
        />
        <span class="gname">{{ activeGroup.label }}</span>
        <code>{{ activeGroup.idPrefix }}</code>
        <span class="muted small">
          {{ activeGroup.source ? `目录取自 ${activeGroup.source}` : '这个通道还没加号' }}
        </span>
        <span class="grow" />
        <span class="state" :class="{ off: !activeGroup.listed }">{{ summary(activeGroup) }}</span>
        <!-- 这是看图的姿势：只看已勾选 / 看全部。不动任何数据。 -->
        <label class="allsel">
          只看已选
          <ToggleSwitch
            :model-value="onlyChecked"
            :disabled="!activeGroup.models.length"
            label="只看已勾选的模型"
            @update:model-value="onlyChecked = $event"
          />
        </label>
        <button
          type="button"
          class="btn sm"
          :disabled="busyPrefix === activeGroup.idPrefix"
          @click="toggleList(activeGroup)"
        >
          {{ activeGroup.listed ? '从列表移除' : '加入列表' }}
        </button>
      </div>

      <div class="body">
        <p v-if="activeGroup.error" class="bad">{{ activeGroup.error }}</p>

        <template v-else-if="activeGroup.models.length">
          <table class="table">
            <thead>
              <tr>
                <th>模型</th>
                <th class="num">上下文</th>
                <th>思考强度</th>
                <th>输入</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="model in shownModels" :key="model.id">
                <td class="mono">
                  <!-- 开关跟名字走：先读「这个模型叫什么」，再决定「要不要它」。 -->
                  <div class="idline">
                    <span>{{ model.id }}</span>
                    <ToggleSwitch
                      :model-value="isChecked(activeGroup, model.id)"
                      :disabled="busyPrefix === activeGroup.idPrefix"
                      :label="model.id"
                      @update:model-value="toggleModel(activeGroup, model.id)"
                    />
                  </div>
                  <div class="sub">{{ model.name || '—' }}</div>
                </td>
                <!--
                  上下文窗口**一律是下拉**：上游给了档位就用它的（provider 真正接受的
                  尺寸），没给就按上限推三档（服务端 `contextOptions`）。不做自由填数字
                  ——那会让「这个值是不是上游认的」变成没人能回答的问题。
                  空选项 = 默认，默认值取最大档；上游没报窗口大小时文案写「上游未报」。
                -->
                <td class="num">
                  <select
                    :value="model.setting?.contextWindow ?? ''"
                    :disabled="busyPrefix === activeGroup.idPrefix"
                    @change="onContextChange(activeGroup, model, ($event.target as HTMLSelectElement).value)"
                  >
                    <option value="">{{ contextHint(model) }}</option>
                    <option v-for="size in model.lengths?.options ?? []" :key="size" :value="size">
                      {{ fmtSize(size) }}
                    </option>
                  </select>
                  <div class="sub">{{ model.max_output_tokens ? `输出 ${fmtSize(model.max_output_tokens)}` : '' }}</div>
                </td>
                <!--
                  思考强度：默认档是「档位表里最高那一档」（网关侧算，见 model-settings.ts）。
                  选「跟随默认」就把配置删掉，回到最高档——这就是「默认打开思考」。
                -->
                <td>
                  <select
                    v-if="model.efforts && model.efforts.length"
                    :value="model.setting?.reasoningEffort ?? ''"
                    :disabled="busyPrefix === activeGroup.idPrefix"
                    @change="onEffortChange(activeGroup, model, ($event.target as HTMLSelectElement).value)"
                  >
                    <option value="">跟随默认（{{ model.effectiveEffort || '—' }}）</option>
                    <option v-for="level in model.efforts" :key="level" :value="level">{{ level }}</option>
                  </select>
                  <span v-else class="muted small">不支持</span>
                </td>
                <!-- 输入模态：文本 / 图片。上游没报就显示 —，不猜。 -->
                <td class="small" :class="{ muted: !model.input }">{{ inputLabel(model.input) }}</td>
              </tr>
            </tbody>
          </table>
        </template>

        <p v-else-if="onlyChecked" class="muted small">这个通道还没有勾选的模型（关掉「只看已选」看全部）。</p>
        <p v-else class="muted small">这个通道还没有可用的模型目录。</p>
      </div>
    </section>

    <p v-if="groups.length === 0 && !state.loading.value" class="muted small">还没有通道。</p>
  </div>
</template>

<style scoped>
/* 标签栏：一个通道一个页签。选中项白底浮起，和 TrendChart 的分段控件同一套观感。 */
.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 0 0 12px;
  padding-bottom: 2px;
  border-bottom: 1px solid var(--line);
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 8px 8px 0 0;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.tab:hover {
  color: var(--fg);
  background: var(--hover);
}

.tab.on {
  background: var(--card);
  border-color: var(--line);
  color: var(--fg);
  font-weight: 600;
  /* 盖住标签栏下边框，做出「这一页和下面那张卡连在一起」的效果。 */
  margin-bottom: -3px;
  padding-bottom: 10px;
}

/* 整家被从列表里移掉时压暗，切页之前就能看出来。 */
.tab.off {
  opacity: 0.55;
}

.tab .count {
  padding: 0 6px;
  border-radius: 99px;
  background: var(--card2);
  color: var(--muted);
  font-size: 11px;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}

.tab.on .count {
  background: var(--accent);
  color: #fff;
}

.intro {
  margin: 0 0 14px;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.8;
}

.card .title {
  gap: 8px;
  flex-wrap: wrap;
}

.gname {
  font-weight: 600;
}

/* 总闸状态：开着是普通灰字，关掉才提醒——关掉意味着这个通道在 DSH 里彻底消失。 */
.state {
  font-size: 12px;
  color: var(--muted);
}

.state.off {
  color: var(--bad);
  background: var(--bad-bg);
  padding: 1px 8px;
  border-radius: 99px;
}

/* 模型 id 和它自己的开关排一行：开关跟着名字走，不单独占一列。 */
.idline {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* 卡头里那个「全部显示」开关：文案和开关贴在一起，别被 flex 的 gap 拉开。 */
.allsel {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--muted);
  user-select: none;
}

.allsel.busy {
  opacity: 0.6;
}

/* 副行：模型显示名、输出上限这类次要信息，缩在 id 下面一行。 */
.sub {
  margin-top: 2px;
  font-size: 11px;
  color: var(--muted);
  font-weight: 400;
}

/* 行内下拉：刻意比卡片里其它控件矮、无边框感，免得一屏几十行全是方框。 */
.table select {
  max-width: 150px;
  padding: 2px 4px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--card);
  color: var(--fg);
  font: inherit;
  font-size: 12px;
}

.table select:disabled {
  opacity: 0.6;
}

.num {
  font-variant-numeric: tabular-nums;
}

.bad {
  color: var(--bad);
  font-size: 12px;
  margin: 6px 0;
}

.flash {
  margin: 0 0 12px;
  font-size: 12px;
}

.flash.ok {
  color: var(--ok);
}

.flash.bad {
  color: var(--bad);
}

</style>
