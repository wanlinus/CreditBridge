/**
 * 全前端唯一的数据获取原语。
 *
 * 不做全局缓存、不做乐观更新、不做自动重试。理由（文档 §7.4）：这个界面上所有数据都是
 * 「服务端状态的投影」，而余额和账本必须是最新的——缓存带来的「显示旧数字」是负价值。
 *
 * 用法：
 *
 * ```ts
 * const { data, loading, error, refresh } = useAsync(() => api.getAccounts())
 * ```
 *
 * `refresh()` 是显式的：页面上的「刷新」按钮直接调它。没有轮询、没有定时器。
 */
import { ref, shallowRef, type Ref } from 'vue';

export interface AsyncState<T> {
  data: Ref<T | null>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  /** 重新拉一次。并发调用只保留最后一次的结果（先发的后到不覆盖新的）。 */
  refresh: () => Promise<void>;
}

export function useAsync<T>(loader: () => Promise<T>, options: { immediate?: boolean } = {}): AsyncState<T> {
  const { immediate = true } = options;

  const data = shallowRef<T | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  // 递增的请求序号：慢请求回来时如果已经有更新的请求发出去过，就丢弃这次结果。
  // 没有这个的话，「快速切页 + 慢接口」会让界面最终显示上一页的数据。
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
