<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { getCatalog, saveVisibility, type ChannelCatalog } from '@/api/models';
import { getChannels, type ChannelAppearance } from '@/api/channels';
import { useAsync } from '@/composables/useAsync';
import { useFlash } from '@/composables/useFlash';
import { fmtNum } from '@/utils/format';
import { errorText } from '@/utils/error';
import ChannelIcon from '@/components/ChannelIcon.vue';

const state = useAsync(getCatalog);
const channelsState = useAsync(getChannels);

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

const looks = computed(() => {
  const map = new Map<string, ChannelAppearance>();
  for (const channel of channelsState.data.value?.channels ?? []) map.set(channel.id, channel);
  return map;
});

const busyPrefix = ref<string | null>(null);
const { flash, say } = useFlash();

function isChecked(group: ChannelCatalog, modelId: string): boolean {
  return group.visible === null ? true : group.visible.includes(modelId);
}

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

async function setAll(group: ChannelCatalog, checked: boolean): Promise<void> {
  const next = checked ? group.models.map((model) => model.id) : [];
  group.visible = next;
  busyPrefix.value = group.idPrefix;
  try {
    await saveVisibility({ prefix: group.idPrefix, visible: next });
    say(checked ? `${group.label}：全部显示` : `${group.label}：一个都不显示`);
  } catch (error) {
    say(errorText(error), 'bad');
    void state.refresh();
  } finally {
    busyPrefix.value = null;
  }
}

async function resetVisible(group: ChannelCatalog): Promise<void> {
  busyPrefix.value = group.idPrefix;
  try {
    await saveVisibility({ prefix: group.idPrefix, action: 'all' });
    group.visible = null;
    group.listed = true;
    say(`${group.label}：恢复全部显示（以后新增的也会出现）`);
  } catch (error) {
    say(errorText(error), 'bad');
    void state.refresh();
  } finally {
    busyPrefix.value = null;
  }
}

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

function summary(group: ChannelCatalog): string {
  if (!group.listed) return '列表已关';
  if (group.visible === null) return '全部显示';
  return `只显示 ${group.visible.length}/${group.models.length}`;
}

const error = computed(() => state.error.value || channelsState.error.value);
</script>

<template>
  <div>
    <p v-if="error" class="alert bad">{{ error }}</p>
    <p v-if="flash" class="flash" :class="flash.tone">{{ flash.text }}</p>

    <p class="intro">
      关掉的模型不会出现在 <code>/v1/models</code> 里，DSH 下一次同步（15 秒）就看不到了。
      改动点一下立即保存——这一页没有「保存」按钮。
    </p>

    <section v-for="group in groups" :key="group.idPrefix" class="card">
      <div class="title">
        <ChannelIcon
          :icon="looks.get(group.channelId)?.icon ?? null"
          :letter="looks.get(group.channelId)?.letter ?? group.label.slice(0, 1)"
          :size="18"
          :alt="group.label"
        />
        <span class="gname">{{ group.label }}</span>
        <code>{{ group.idPrefix }}</code>
        <span class="muted small">{{ group.source ? `目录取自 ${group.source}` : '这个通道还没加号' }}</span>
        <span class="grow" />
        <span class="state" :class="{ off: !group.listed }">{{ summary(group) }}</span>
        <button type="button" class="btn sm" :disabled="busyPrefix === group.idPrefix" @click="toggleList(group)">
          {{ group.listed ? '从列表移除' : '加入列表' }}
        </button>
      </div>

      <div class="body">
        <p v-if="group.error" class="bad">{{ group.error }}</p>

        <template v-else-if="group.models.length">
          <div class="bulk">
            <button type="button" class="btn sm" :disabled="busyPrefix === group.idPrefix" @click="setAll(group, true)">
              全选
            </button>
            <button type="button" class="btn sm" :disabled="busyPrefix === group.idPrefix" @click="setAll(group, false)">
              全不选
            </button>
            <button type="button" class="btn sm ghost" :disabled="busyPrefix === group.idPrefix" @click="resetVisible(group)">
              恢复默认
            </button>
            <span class="muted small">
              「恢复默认」会清掉限制：以后上游新增的模型也会自动出现。
            </span>
          </div>

          <table class="table">
            <tbody>
              <tr v-for="model in group.models" :key="model.id">
                <td class="pick">
                  <input
                    type="checkbox"
                    :checked="isChecked(group, model.id)"
                    :disabled="busyPrefix === group.idPrefix"
                    :aria-label="model.id"
                    @change="toggleModel(group, model.id)"
                  />
                </td>
                <td class="mono">{{ model.id }}</td>
                <td>{{ model.name || '—' }}</td>
                <td class="num muted small">{{ model.context_length ? `${fmtNum(model.context_length, 0)} 上下文` : '' }}</td>
                <td class="num muted small">{{ model.max_output_tokens ? `${fmtNum(model.max_output_tokens, 0)} 输出` : '' }}</td>
              </tr>
            </tbody>
          </table>
        </template>

        <p v-else class="muted small">这个通道还没有可用的模型目录。</p>
      </div>
    </section>

    <p v-if="groups.length === 0 && !state.loading.value" class="muted small">还没有通道。</p>
  </div>
</template>

<style scoped>
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

.bulk {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.pick {
  width: 28px;
}

.pick input {
  width: 15px;
  height: 15px;
  cursor: pointer;
  accent-color: var(--accent);
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
