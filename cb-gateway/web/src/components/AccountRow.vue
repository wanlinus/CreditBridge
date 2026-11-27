<script setup lang="ts">
/**
 * 账号列表的一行：展示 + 全部管理动作。
 *
 * ## 为什么动作分两层
 *
 * 旧页面把七个按钮平铺在一行里（详情、停用、重新登录、上游退出、换设备号、删除…），
 * 结果是每个按钮都只剩两个字，而「换设备号」这种动作**后果不可从小字看出**。
 * 这里按「常用 / 少见」分两层：行内只留检测、停用、更多；更多展开后每个动作配一句
 * 后果说明。删除再单独走一次行内确认——`window.confirm` 没法把「会让多少个模型 id
 * 消失」排版清楚。
 *
 * ## 能力位决定显示什么
 *
 * `canVerify` / `canLogin` / `canLogout` / `canRotateDevice` 都来自 `GET /api/accounts`
 * 的 `channels[]`，**前端不认识任何具体通道**。加一个通道不用动这个文件。
 */
import { computed, ref } from 'vue';

import {
  deleteAccount,
  logoutAccount,
  patchAccount,
  rotateDevice,
  setAccountCheckin,
  type AccountRow,
  type ChannelCapability,
} from '@/api/accounts';
import { useAccountActions } from '@/composables/useAccountActions';
import { useFlash } from '@/composables/useFlash';
import { useInlineRename } from '@/composables/useInlineRename';
import { upstreamIdentity } from '@/utils/account';
import { fmtNum, fmtTokens } from '@/utils/format';
import StatusBadge from '@/components/StatusBadge.vue';
import ToggleSwitch from '@/components/ToggleSwitch.vue';
import { errorText } from '@/utils/error';

const props = defineProps<{
  account: AccountRow;
  channel: ChannelCapability;
  /** 正在去上游读余额：按钮转圈并禁用，避免连点把上游打满。 */
  refreshing?: boolean;
}>();

const emit = defineEmits<{
  /** 数据变了（状态、显示名、删除），父组件负责重新拉列表。 */
  (e: 'changed'): void;
  /** 用同一个上游账号重新登录；起任务由父组件负责（要借用点击手势开窗）。 */
  (e: 'login'): void;
  /** 主动去上游读一次余额（绕过网关的 30 秒缓存）。请求由父组件发，这里只报意图。 */
  (e: 'refresh'): void;
}>();

const open = ref(false);
const confirming = ref(false);
const { flash, say } = useFlash();

/** 上游身份：和显示名一样时不显示（否则「账号A 账号A」并排两遍）。 */
const upstreamText = computed(() => upstreamIdentity(props.account.profile, props.account.label));

/** 展开区那一行说明有没有内容可写（三个动作都没有时就整行不渲染）。 */
const hasHint = computed(() => props.channel.canLogin || props.channel.canLogout || props.channel.canRotateDevice);

/* ------------------------------ 改名 ------------------------------ */

// 和密钥页共用同一套「点一下变输入框」的实现（`useInlineRename`），
// 差别只有保存时调哪个接口。
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

/* ------------------------------ 动作 ------------------------------ */

// 检测 / 停用这两个动作和账号详情页共用一份实现（`useAccountActions`）：
// 复制的后果不是现在出错，而是以后改一处忘另一处。
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

/** 改这个号的自动签到开关。和「停用」是两件事：停用是整个号不用了，这个只管签到。 */
async function setCheckin(value: boolean): Promise<void> {
  busy.value = true;
  try {
    await setAccountCheckin(props.account.id, value);
    emit('changed');
    say(value ? '这个号会参与自动签到' : '这个号不再自动签到（手动点仍然可以签）', 'ok');
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
    // 不 say：这一行马上就被父组件的刷新移除了，提示会跟着消失。
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

      <!-- 显示名：点一下就地改。没有名字的号占位「未命名」，否则那一列是空的，看着像没加载出来。 -->
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
      <StatusBadge :status="account.status" :title="account.statusMessage" />

      <span class="grow" />

      <span class="cell">
        <i>余额</i>{{ typeof account.totalRemain === 'number' ? fmtNum(account.totalRemain) : '—' }}
        <!--
          主动去上游读一次：余额在网关里带 30 秒缓存（挡住密集轮询），这个按钮的语义
          恰恰是「我不信缓存，现在就去问」。放在数字右边而不是「更多」里——它是常用动作，
          而且点完要能立刻看到这个数字变了。
        -->
        <button
          type="button"
          class="mini"
          :disabled="refreshing"
          :title="refreshing ? '正在向上游查询…' : '去上游读一次最新积分'"
          aria-label="刷新积分"
          @click="emit('refresh')"
        >
          {{ refreshing ? '⋯' : '↻' }}
        </button>
      </span>
      <span class="cell"><i>今日</i>{{ fmtTokens(account.todayTokens) }}</span>

      <div class="acts">
        <!--
          停用的号不给「检测」：`POST /api/accounts/:id/verify` 成功时会 `markReady()`，
          也就是**检测顺手把停用撤销了**。停用是人为决定，不该被一次验活悄悄推翻；
          真要验，先点「启用」。
        -->
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
      <!-- 签到开关和「停用」分开放：停用是整个号不用了，这个只管自动签到。 -->
      <label v-if="channel.canCheckin" class="checkin-toggle">
        <ToggleSwitch
          :model-value="account.checkinEnabled"
          :disabled="busy"
          :label="`${account.label} 自动签到`"
          @update:model-value="setCheckin"
        />
        <span class="small">自动签到</span>
      </label>
      <span class="grow" />
      <button type="button" class="btn sm danger" :disabled="busy" @click="confirming = true">删除账号</button>
    </div>

    <!-- 只解释**这一行真的有**的动作：WorkBuddy 没有换设备号，就不该在这里讲 9074。 -->
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

/* 显示名做成按钮：它既是文字又是可点的入口，用 button 才有无障碍语义。 */
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

/*
 * 余额右边那个「刷新」小按钮。
 *
 * 用 `↻` 而不是「刷新」两个字：一行里已经有「检测 / 停用 / 更多」三个带字的按钮，
 * 再来一个就挤成一排灰块。可读性靠 `title` 和 `aria-label` 兜底，通道标题栏那边
 * 还有一个带字体的「刷新积分」，所以这个符号不会被误解成别的东西。
 */
.mini {
  margin-left: 4px;
  padding: 0 3px;
  border: 0;
  background: none;
  color: var(--muted);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  border-radius: 3px;
}

.mini:hover:not(:disabled) {
  color: var(--fg);
  background: var(--hover);
}

.mini:disabled {
  cursor: default;
  opacity: 0.6;
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

/* 开关和按钮并排：`<label>` 让点击文字也能切换，比只有那个小圆钮好点。 */
.checkin-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
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
