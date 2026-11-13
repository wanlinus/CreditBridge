import { ref, type Ref } from 'vue';

import { patchAccount, verifyAccount } from '@/api/accounts';
import { errorText } from '@/utils/error';

interface Actionable {
  id: string;
  status: string;
}

export interface AccountActionsOptions {
  account: Ref<Actionable | null | undefined>;
  onChanged: () => void;
  onSay: (text: string, tone: 'ok' | 'bad') => void;
}

export function useAccountActions(options: AccountActionsOptions) {
  const busy = ref(false);

  async function verify(): Promise<void> {
    const target = options.account.value;
    if (!target) return;
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
