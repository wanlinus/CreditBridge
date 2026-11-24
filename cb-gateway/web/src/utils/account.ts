/**
 * 账号相关的展示逻辑。
 *
 * 抽出来是因为同一个文案在两处算就会在两处漂移：账号列表和详情页各有一份「上游身份」
 * 的实现，逻辑一模一样。
 */

export interface AccountProfileLike {
  username?: string | null;
  uid?: string | null;
}

/**
 * 上游身份文案。
 *
 * **和显示名一样时返回空串**：登录时 label 默认取上游 username，于是
 * `账号A 账号A` 并排出现两次，读起来像界面出错（生产五个号里有四个是这种）。
 * 返回空串让调用方一个 `v-if` 就够，不用在模板里再比一次。
 */
export function upstreamIdentity(profile: AccountProfileLike | null | undefined, label: string): string {
  const text = profile?.username
    ? String(profile.username)
    : profile?.uid
      ? `uid ${String(profile.uid).slice(0, 10)}`
      : '';
  if (text === '' || text === label) return '';
  return text;
}

/**
 * 能不能给这个通道再加一个号。
 *
 * 账号页标题条和「添加账号」面板都要这个判断，共用一份——否则会出现「页面上没有
 * + 添加按钮，但面板里那个选项却可点」这种自相矛盾。
 */
export function canAddAccount(
  channel: { id: string; canLogin: boolean; multiAccount: boolean },
  accounts: { channelId: string }[],
): boolean {
  if (!channel.canLogin) return false;
  if (channel.multiAccount) return true;
  return !accounts.some((account) => account.channelId === channel.id);
}
