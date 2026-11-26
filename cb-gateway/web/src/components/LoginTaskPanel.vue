<script setup lang="ts">
/**
 * 登录对话框：**遮罩 + 居中弹窗**，把「现在卡在哪一步」摊开给用户看。
 *
 * 为什么是弹窗而不是页面内嵌面板：登录是打断性动作（要切到手机收验证码、
 * 要去客户端复制 cookie），内嵌在账号列表里会被上下内容挤走，滚一下就不见了。
 *
 * 交互逻辑在 `composables/useLoginPrompt.ts`（那里面有两个反直觉的坑）；
 * 每种输入形态是 `components/login/` 下的独立组件。这里只负责外壳和状态分支。
 */
import { computed, onBeforeUnmount, onMounted } from 'vue';

import type { LoginTask } from '@/api/accounts';
import { fmtClock } from '@/utils/format';
import { useLoginPrompt } from '@/composables/useLoginPrompt';
import AuthLinkList from '@/components/login/AuthLinkList.vue';
import CaptchaCard from '@/components/login/CaptchaCard.vue';
import PromptCard from '@/components/login/PromptCard.vue';

const props = defineProps<{
  task: LoginTask;
  /** 出现过的授权链接，按顺序去重。 */
  urls: string[];
  /** 操作级错误（回填失败等）。任务本身的失败在 `task.message`。 */
  error: string | null;
  busy: boolean;
  channelLabel: string;
}>();

const emit = defineEmits<{
  (e: 'answer', value: string): void;
  (e: 'cancel'): void;
  (e: 'close'): void;
}>();

const { activePrompt, waiting, hold } = useLoginPrompt(() => props.task);

const stateText = computed(() => {
  if (props.task.state === 'running') return '进行中';
  if (props.task.state === 'done') return '已完成';
  if (props.task.state === 'cancelled') return '已取消';
  return '失败';
});

const tone = computed(() => {
  if (props.task.state === 'done') return 'ok';
  if (props.task.state === 'cancelled') return 'muted';
  if (props.task.state === 'error') return 'bad';
  return 'warn';
});

/** 任务失败时上游出的验证题（1105 那种，用户还能补做一次）。 */
const failChallenge = computed(() => props.task.challenge ?? null);

/** 验证码类型的中文名。值来自豆包 captcha.js 的类型表。 */
const CHALLENGE_LABELS: Record<string, string> = {
  slide: '滑动滑块',
  '3d': '3D 验证',
  text: '输入文字',
  icon: '点选图标',
  whirl: '旋转图片',
  semantic_reasoning: '按提示点选',
};

const failChallengeLabel = computed(() => {
  const subtype = failChallenge.value?.subtype;
  return (subtype && CHALLENGE_LABELS[subtype]) || '图形验证码';
});

/**
 * 关闭弹窗。任务还在跑时这是**取消**——网关那边不该留一个没人看的任务空转到超时。
 *
 * 只在用户明确动作时调用（✕、ESC、底部的「取消登录」）。**遮罩点击不算**：
 * 收验证码时手滑点一下外面就把整条登录废掉，代价太大。
 */
function dismiss(): void {
  if (props.task.state === 'running') emit('cancel');
  else emit('close');
}

/** ✕ 的提示语：说清这一下会作废已经发出的验证码。 */
const closeTitle = computed(() =>
  props.task.state === 'running' ? '取消这次登录（已发出的验证码会作废）' : '关闭',
);

/** 提交答案前先把当前 prompt 留住，避免网关处理期间表单被卸掉。 */
function answer(value: string): void {
  hold();
  emit('answer', value);
}

// ESC 关闭。挂在 window 上而不是元素上：焦点可能在按钮或输入框里。
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') dismiss();
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <!--
    遮罩**点了不关**，只有 ✕ 和 ESC 能关。

    2026-11-26 踩过：原来 `@click.self="dismiss"`，而 `dismiss()` 在任务进行中是
    「取消」——用户在手机上收验证码时手滑点一下弹窗外面，整条登录就被取消了，
    已经发出的验证码作废、输入框消失。重新发起又要等 60 秒才能再发码。
    关闭是个破坏性动作，不该由「点空白」这种误触触发。
  -->
  <div class="overlay" role="dialog" aria-modal="true" :aria-label="`${channelLabel} 登录`">
    <div class="dialog">
      <header class="head">
        <span class="dot" :class="`tone-${tone}`" aria-hidden="true" />
        <h2 class="title">{{ channelLabel }} 登录</h2>
        <span class="state" :class="`tone-${tone}`">{{ stateText }}</span>
        <span class="clock">{{ fmtClock(task.startedAt) }}</span>
        <span class="grow" />
        <button type="button" class="btn sm ghost close" :title="closeTitle" :aria-label="closeTitle" @click="dismiss">
          ✕
        </button>
      </header>

      <div class="body">
        <template v-if="task.state === 'running'">
          <!-- 授权链接（Qoder / Trae 这类 URL 登录）。没有链接时说明还在等上游。 -->
          <AuthLinkList v-if="urls.length > 0" :urls="urls" />
          <p v-else-if="!activePrompt" class="hint">正在等上游给出授权链接…（最多等 5 分钟）</p>

          <!-- 当前该填的一步 -->
          <PromptCard
            v-if="activePrompt"
            :key="activePrompt.id"
            :prompt="activePrompt"
            :waiting="busy || waiting"
            :error="error"
          @answer="answer"
          />
        </template>

        <p v-else-if="task.state === 'done'" class="result ok">
          <span class="mark">✓</span>
          <span>
            登录成功<template v-if="task.accountId">：账号 <code>{{ task.accountId }}</code> 已加入</template>。
          </span>
        </p>

        <p v-else-if="task.state === 'cancelled'" class="result muted">这次登录已经取消。</p>

        <template v-else>
          <p class="result bad"><span class="mark">!</span><span>{{ task.message || '登录失败（上游没给原因）' }}</span></p>
          <!-- 上游出了验证题才显示。能在失败后补做一次就补，省得用户从头登录。 -->
          <div v-if="failChallenge" class="retry-captcha">
            <CaptchaCard
              :challenge="failChallenge"
              :label="failChallengeLabel"
              :disabled="true"
              @done="() => {}"
            />
          </div>
        </template>

        <p v-if="error && task.state !== 'running'" class="result bad">{{ error }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 遮罩：铺满视口、压住下面的页面。z-index 高于侧边栏和 Toast 之下的层级。 */
.overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  padding: 24px;
  /* 用 rgba() 而不是 `rgb(15 23 42 / 46%)`：后者是 Color 4 语法，
     老 Chrome / 某些内嵌 WebView 不认，静默变成完全透明——遮罩形同虚设。 */
  background: rgba(15, 23, 42, 0.46);
  /* 无头 Chrome（--disable-gpu）不渲染 backdrop-filter，但不影响暗度。 */
  backdrop-filter: blur(2px);
  /* 遮罩出现时不让背后页面滚动 */
  overscroll-behavior: contain;
  animation: fade-in 0.14s ease-out;
}

.dialog {
  width: min(520px, 100%);
  max-height: min(82vh, 680px);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--card);
  box-shadow:
    0 0 0 1px rgba(15, 23, 42, 0.04),
    0 24px 60px rgba(15, 23, 42, 0.28);
  overflow: hidden;
  animation: pop-in 0.16s cubic-bezier(0.2, 0.8, 0.3, 1);
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 13px 16px;
  border-bottom: 1px solid var(--line);
  background: var(--card2);
  flex: none;
}

/* 状态圆点：比文字徽标更轻，一眼看出在跑 / 成了 / 挂了。 */
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
}

.dot.tone-warn,
.state.tone-warn {
  color: var(--warn);
}

.dot.tone-warn {
  background: var(--warn);
  animation: pulse 1.4s ease-in-out infinite;
}

.dot.tone-ok,
.state.tone-ok {
  color: var(--ok);
}

.dot.tone-ok {
  background: var(--ok);
}

.dot.tone-bad,
.state.tone-bad {
  color: var(--bad);
}

.dot.tone-bad {
  background: var(--bad);
}

.dot.tone-muted,
.state.tone-muted {
  color: var(--muted);
}

.dot.tone-muted {
  background: var(--muted);
}

.title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.state {
  font-size: 11px;
  font-weight: 500;
  padding: 1px 7px;
  border-radius: 99px;
  background: var(--card);
  border: 1px solid currentcolor;
}

.clock {
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.grow {
  flex: 1;
}

.close {
  flex: none;
}

.body {
  padding: 16px;
  overflow-y: auto;
  /* 长内容（比如 cookie 输入提示）不要撑破弹窗 */
  min-height: 0;
}

.hint {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}

/* 结果行：图标 + 文字，图标不要被文字挤走 */
.result {
  display: flex;
  gap: 8px;
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
}

.result .mark {
  flex: none;
  font-weight: 700;
}

.result.ok {
  color: var(--ok);
}

.result.bad {
  color: var(--bad);
}

.result.muted {
  color: var(--muted);
}

.retry-captcha {
  margin-top: 12px;
}

@keyframes fade-in {
  from {
    opacity: 0;
  }
}

@keyframes pop-in {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.985);
  }
}

/* 只让指示「正在跑」的圆点呼吸，别让整个弹窗动。 */
@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }

  50% {
    opacity: 0.35;
  }
}

/* 系统开了减少动效就别转圈。 */
@media (prefers-reduced-motion: reduce) {
  .overlay,
  .dialog,
  .dot {
    animation: none;
  }
}
</style>
