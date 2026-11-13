import { ref, shallowRef, type Ref } from 'vue';

export interface AsyncState<T> {
  data: Ref<T | null>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  refresh: () => Promise<void>;
}

export function useAsync<T>(loader: () => Promise<T>, options: { immediate?: boolean } = {}): AsyncState<T> {
  const { immediate = true } = options;

  const data = shallowRef<T | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  let seq = 0;

  async function refresh(): Promise<void> {
    const mine = ++seq;
    loading.value = true;
    error.value = null;
    try {
      const value = await loader();
      if (mine !== seq) return;
      data.value = value;
    } catch (err: any) {
      if (mine !== seq) return;
      error.value = err?.message || String(err);
    } finally {
      if (mine === seq) loading.value = false;
    }
  }

  if (immediate) void refresh();

  return { data, loading, error, refresh };
}
