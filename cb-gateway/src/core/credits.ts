import type { Account, Channel, CheckinRecord, UsagePackage } from '../types.ts';
import { channelById } from '../channels/index.ts';
import { usageSummary } from '../ledger.ts';

const CREDITS_TTL_MS = 30_000;

export interface CreditSnapshot {
  remain: number | null;
  used: number | null;
  limit: number | null;
  prevRemain: number | null;
  prevAt: number | null;
  at: number;
}

const creditsCache = new Map<string, CreditSnapshot>();

function sumPackages(packages: any): { used: number | null; limit: number | null } {
  const list = Array.isArray(packages) ? packages : [];
  if (list.length === 0) return { used: null, limit: null };
  const everyNumber = (key: string) => list.every((item: any) => typeof item?.[key] === 'number');
  return {
    used: everyNumber('used') ? list.reduce((sum: number, item: any) => sum + item.used, 0) : null,
    limit: everyNumber('limit') ? list.reduce((sum: number, item: any) => sum + item.limit, 0) : null,
  };
}

export async function creditsByAccount(accounts: Account[]): Promise<Record<string, CreditSnapshot>> {
  const out: Record<string, CreditSnapshot> = {};
  const now = Date.now();
  await Promise.all(
    accounts.map(async (account) => {
      const cached = creditsCache.get(account.id);
      if (cached && now - cached.at < CREDITS_TTL_MS) {
        out[account.id] = cached;
        return;
      }
      const channel = channelById(account.channelId);
      if (!channel) {
        out[account.id] = { remain: null, used: null, limit: null, prevRemain: cached?.prevRemain ?? null, prevAt: cached?.prevAt ?? null, at: now };
        return;
      }
      try {
        const credits = await channel.creditsOf(account);
        const remain = typeof credits.totalRemain === 'number' ? credits.totalRemain : null;
        const { used, limit } = sumPackages((credits as any).packages);
        const snapshot: CreditSnapshot = {
          remain,
          used,
          limit,
          prevRemain: cached?.remain ?? null,
          prevAt: cached?.at ?? null,
          at: now,
        };
        out[account.id] = snapshot;
        if (remain !== null) creditsCache.set(account.id, snapshot);
      } catch {
        out[account.id] = { remain: null, used: null, limit: null, prevRemain: cached?.prevRemain ?? null, prevAt: cached?.prevAt ?? null, at: now };
      }
    }),
  );
  if (creditsCache.size > accounts.length) {
    const alive = new Set(accounts.map((account) => account.id));
    for (const id of creditsCache.keys()) if (!alive.has(id)) creditsCache.delete(id);
  }
  return out;
}

function authFlags(channel: Channel) {
  return {
    loggedIn: true,
    canLogin: typeof channel.login === 'function',
    canLogout: typeof channel.logoutOf === 'function',
  };
}

function accountMeta(account: Account) {
  return {
    id: account.id,
    label: account.label,
    status: account.status,
    statusMessage: account.statusMessage,
    cooldownUntil: account.cooldownUntil,
  };
}

export async function accountsWithSpend(accounts: Account[]) {
  const [credits, summary] = await Promise.all([
    creditsByAccount(accounts),
    usageSummary({}),
  ]);
  const tokensToday: Record<string, number> = {};
  const tokensTotal: Record<string, number> = {};
  for (const row of summary.todayByAccount) tokensToday[row.account] = row.tokens;
  for (const row of summary.byAccount) tokensTotal[row.account] = row.tokens;
  return { credits, summary, tokensToday, tokensTotal };
}

export interface CreditsView {
  provider: string;
  supported: boolean;
  totalRemain?: number;
  packages?: UsagePackage[];
  account?: Record<string, unknown>;
  error?: string;
  label: string;
  idPrefix: string;
  checkin: CheckinRecord | null;
  loggedIn: boolean;
  canLogin: boolean;
  canLogout: boolean;
}

export async function buildCredits(channel: Channel, account: Account): Promise<CreditsView> {
  const meta = {
    label: channel.label,
    idPrefix: channel.idPrefix,
    checkin: channel.lastCheckinOf?.(account) ?? null,
    ...authFlags(channel),
  };
  try {
    const credits = await channel.creditsOf(account);
    return {
      ...credits,
      account: { ...(credits.account || {}), ...accountMeta(account) },
      ...meta,
    };
  } catch (error: any) {
    return {
      supported: false,
      provider: channel.id,
      error: error.message,
      account: accountMeta(account),
      ...meta,
    };
  }
}
