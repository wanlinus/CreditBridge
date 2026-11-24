/**
 * 就地改名：点一下变输入框，回车保存、Esc 取消。
 *
 * ## 为什么抽出来
 *
 * 账号列表的显示名和密钥的名字各写了一遍同样的 20 行：`editing` / `draft` / `inputEl`
 * / `nextTick` 后 `focus()` + `select()` / 空白值忽略 / 保存失败退回。两处唯一的差别是
 * 「保存」调哪个接口。
 *
 * 细节里有一条容易漏：`nextTick()` 之后才能 `focus()`——输入框是 `v-if` 渲染的，
 * 同步拿 ref 还是 null。漏了不会报错，只是第一次点进去要再点一下才能打字。
 */
import { nextTick, ref } from 'vue';

export interface InlineRenameOptions {
  /** 当前值（用来判断「真的改了吗」）。 */
  value: () => string;
  /** 保存新值。抛错由调用方处理提示。 */
  save: (next: string) => Promise<void>;
}

export function useInlineRename(options: InlineRenameOptions) {
  const editing = ref(false);
  const draft = ref('');
  const inputEl = ref<HTMLInputElement | null>(null);

  async function start(): Promise<void> {
    draft.value = options.value();
    editing.value = true;
    await nextTick();
    inputEl.value?.focus();
    inputEl.value?.select();
  }

  function cancel(): void {
    editing.value = false;
  }

  async function commit(): Promise<void> {
    const next = draft.value.trim();
    editing.value = false;
    // 空名字没有意义（后端也会忽略），没改也没必要发请求。
    if (next === '' || next === options.value()) return;
    await options.save(next);
  }

  return { editing, draft, inputEl, start, cancel, commit };
}
