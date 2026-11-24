/**
 * 账号的两个通用动作：检测、停用/启用。
 *
 * ## 为什么要抽出来
 *
 * 这两个动作在**账号列表的一行**和**账号详情页的头部**各写了一遍，逻辑一模一样：
 * 置 busy → 调接口 → 无论成败都刷新（检测失败可能把状态改成「凭据失效」，刷新才能看到）
 * → 说一句结果。两处唯一的差别是「刷新」怎么做（列表 emit 事件、详情页直接重拉）。
 *
 * 复制粘贴的后果不是现在出错，而是**以后改一处忘另一处**——比如给检测加上「成功时
 * 顺便刷新余额」，列表改了、详情页没改，两个页面对同一个操作的反馈就不一样了。
 *
 * ## 为什么 `onChanged` 在失败分支也调用
 *
 * `POST /verify` 失败时如果是**永久失效**，网关会把账号标成 `invalid`（见
 * `routes/accounts.ts`）。不刷新的话界面还显示「就绪」，而真实状态已经变了。
 */
import { ref, type Ref } from 'vue';

import { patchAccount, verifyAccount } from '@/api/accounts';
import { errorText } from '@/utils/error';

/** 这两个动作只需要账号的 id 和 status。 */
interface Actionable {
  id: string;
  status: string;
}

export interface AccountActionsOptions {
  account: Ref<Actionable | null | undefined>;
  /** 动作之后刷新数据（必调，成败都要）。 */
  onChanged: () => void;
  /** 给人看的结果。 */
  onSay: (text: string, tone: 'ok' | 'bad') => void;
}

export function useAccountActions(options: AccountActionsOptions) {
  const busy = ref(false);

  async function verify(): Promise<void> {
    const target = options.account.value;
    if (!target) return;
    /**
     * **停用的号不验活**——这条守卫必须在这里，不能只写在某个页面的 `v-if` 上。
     *
     * `POST /api/accounts/:id/verify` 成功后会无条件 `markReady()`（见 `routes/accounts.ts`），
     * 也就是**检测顺手把人为停用撤销了**。模板层漏写一次（详情页就漏了）后果是：
     * 用户在详情页点一下「检测」，那个号就悄悄开始接请求了。
     */
    if (target.status === 'disabled') {
      options.onSay('这个号是停用状态，先点「启用」再检测', 'bad');
      return;
    }
    busy.value = true;
    try {
      await verifyAccount(target.id);
      options.onChanged();
      options.onSay('检测通过：凭据有效', 'ok');
    } catch (error) {
      // 失败也要刷新：永久失效时网关已经把状态改成 invalid 了。
      options.onChanged();
      options.onSay(errorText(error), 'bad');
    } finally {
      busy.value = false;
    }
  }

  async function toggle(): Promise<void> {
    const target = options.account.value;
    if (!target) return;
    const next = target.status === 'disabled' ? 'ready' : 'disabled';
    busy.value = true;
    try {
      await patchAccount(target.id, { status: next });
      options.onChanged();
      options.onSay(next === 'ready' ? '已启用' : '已停用：这个号不再接请求，凭据不删', 'ok');
    } catch (error) {
      options.onSay(errorText(error), 'bad');
    } finally {
      busy.value = false;
    }
  }

  return { busy, verify, toggle };
}
