export interface AccountProfileLike {
  username?: string | null;
  uid?: string | null;
}

export function upstreamIdentity(profile: AccountProfileLike | null | undefined, label: string): string {
  const text = profile?.username
    ? String(profile.username)
    : profile?.uid
      ? `uid ${String(profile.uid).slice(0, 10)}`
      : '';
  if (text === '' || text === label) return '';
  return text;
}

export function canAddAccount(
  channel: { id: string; canLogin: boolean; multiAccount: boolean },
  accounts: { channelId: string }[],
): boolean {
  if (!channel.canLogin) return false;
  if (channel.multiAccount) return true;
  return !accounts.some((account) => account.channelId === channel.id);
}
