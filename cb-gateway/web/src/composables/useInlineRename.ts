import { nextTick, ref } from 'vue';

export interface InlineRenameOptions {
  value: () => string;
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
    if (next === '' || next === options.value()) return;
    await options.save(next);
  }

  return { editing, draft, inputEl, start, cancel, commit };
}
