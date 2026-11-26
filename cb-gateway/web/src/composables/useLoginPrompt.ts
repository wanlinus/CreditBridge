/**
 * 登录弹窗的交互状态：当前该渲染哪个 prompt、输入框里的值。
 *
 * 抽出来的理由：这部分逻辑有**两个反直觉的坑**，混在模板里没人看得见，
 * 而它们的表现都是「界面看起来坏了」：
 *
 * 1. **换步才清空输入框**：轮询每 1.2 秒换一份快照，`prompt.id` 不变就不该清，
 *    否则用户输到一半就被清空。
 * 2. **提交后不能立刻卸掉表单**：网关处理期间快照里 `prompt` 是 `null`，
 *    `v-if` 一撤输入框就消失（用户看到「打完字框没了」）。用 `pendingPrompt` 顶住。
 */
import { computed, ref, watch } from 'vue';
import type { LoginPrompt, LoginTask } from '@/api/accounts';

export function useLoginPrompt(task: () => LoginTask) {
  /** 输入框当前值。换步时清空。 */
  const value = ref('');

  /**
   * 提交后到下一个 prompt 出现之间的过渡态。
   *
   * 不这样会「输入框一输入就消失」：`submit()` 之后网关正在处理，轮询回来的快照里
   * `prompt` 是 `null`，那个 `v-if` 就把整个 form 卸掉了。用户看到的是
   * 「我刚打完字，框没了」——像是操作失败，实际只是中间态。
   */
  const pendingPrompt = ref<LoginPrompt | null>(null);

  /** 当前该渲染哪个 prompt：优先用新鲜的，没有就用提交时暂存的那份。 */
  const activePrompt = computed<LoginPrompt | null>(() => task().prompt ?? pendingPrompt.value);

  /** 网关还在处理上一步，控件应全部置灰。 */
  const waiting = computed(() => task().prompt === null && task().state === 'running');

  // 换了 prompt 才清空。同一 id 的每 1.2 秒一次快照不该动用户输入。
  watch(
    () => task().prompt?.id,
    () => {
      value.value = '';
    },
  );

  // 网关给出新的 prompt（或任务结束时清空）就把暂存丢掉。
  watch(
    () => task().prompt,
    (next) => {
      if (next && next.id !== pendingPrompt.value?.id) pendingPrompt.value = null;
      else if (next === null && task().state !== 'running') pendingPrompt.value = null;
    },
  );

  watch(
    () => task().state,
    (state) => {
      if (state !== 'running') pendingPrompt.value = null;
    },
  );

  /** 提交前先把当前 prompt 留住，等下一个覆盖它。 */
  function hold(): void {
    pendingPrompt.value = task().prompt ?? null;
  }

  return { value, activePrompt, waiting, hold };
}
