import type { Account, Channel } from '../types.ts';
import { buildCredits } from './credits.ts';
import { usageSummary } from '../ledger.ts';

export interface BadgeView {
  channel: string;
  title: string;
  amount: string;
  today: string;
  note: string | null;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 100) return String(Math.round(n));
  return String(Math.round(n * 1000) / 1000);
}

function fmtSize(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1_000_000) {
    const millions = n / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

export async function buildBadge(channel: Channel, account: Account): Promise<BadgeView> {
  const [credits, usage] = await Promise.all([
    buildCredits(channel, account),
    usageSummary({ account: account.id }).catch(() => null),
  ]);

  const error = typeof credits.error === 'string' ? credits.error : '';

  let amount: string;
  if (error !== '') {
    amount = '—';
  } else if (!credits.supported) {
    amount = '已连接';
  } else if (typeof credits.totalRemain === 'number') {
    amount = fmt(credits.totalRemain);
  } else {
    amount = '已连接';
  }

  const today = usage ? usage.today : null;
  const creditsToday = today && typeof today.credits === 'number' ? today.credits : null;
  const tokensToday = today ? (Number(today.promptTokens) || 0) + (Number(today.completionTokens) || 0) : 0;
  const requests = today ? Number(today.requests) || 0 : 0;

  let todayText = '';
  if (creditsToday !== null && creditsToday > 0) todayText = `今日 ${fmt(creditsToday)}`;
  else if (tokensToday > 0) todayText = `今日 ${fmtSize(tokensToday)} tok`;
  else if (requests > 0) todayText = `今日 ${requests} 次`;

  return {
    channel: channel.id,
    title: `${channel.label} · ${account.label}`,
    amount,
    today: todayText,
    note: error !== '' ? error : null,
  };
}
