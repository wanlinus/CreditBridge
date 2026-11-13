import { channels } from '../channels/index.ts';
import { accountsOf } from './accounts.ts';
import { log } from '../logger.ts';
import { localDate } from '../shared/clock.ts';
import { config, isValidCheckinTime } from '../config.ts';
import { appendCheckinLog } from './checkin-log.ts';

const RETRY_DELAY_MS = 60 * 60 * 1000;

const TRANSIENT_RETRY_DELAYS_MS = [10 * 60 * 1000, 30 * 60 * 1000, 60 * 60 * 1000];

const testHooks: { retryDelayMs?: number; setTimeout?: typeof setTimeout } = {};

export function setSchedulerHooksForTests(hooks: { retryDelayMs?: number; setTimeout?: typeof setTimeout }): void {
  Object.assign(testHooks, hooks);
}

export function resetSchedulerHooksForTests(): void {
  testHooks.retryDelayMs = undefined;
  testHooks.setTimeout = undefined;
}

function retryDelay(): number {
  return testHooks.retryDelayMs ?? RETRY_DELAY_MS;
}

function schedule(fn: () => void, delay: number): void {
  (testHooks.setTimeout ?? setTimeout)(fn, delay);
}

function settledForToday(last: { date?: string; status?: string } | null, today: string): boolean {
  if (!last || last.date !== today) return false;
  return last.status === 'checked' || last.status === 'already' || last.status === 'disabled';
}

function pendingAccounts(today: string) {
  const out: { channel: (typeof channels)[number]; account: ReturnType<typeof accountsOf>[number] }[] = [];
  for (const channel of channels) {
    if (typeof channel.checkinClaimOf !== 'function') continue;
    for (const account of accountsOf(channel.id)) {
      if (account.status !== 'ready') continue;
      const last = channel.lastCheckinOf?.(account) ?? null;
      if (settledForToday(last, today)) continue;
      out.push({ channel, account });
    }
  }
  return out;
}

function isTransient(error: any): boolean {
  return Boolean(error) && error.transient === true;
}

function retryableError(record: { message?: string | null; transient?: boolean }): any {
  return Object.assign(new Error(record.message || '签到失败'), { transient: record.transient === true });
}

async function claimAll(items: { channel: (typeof channels)[number]; account: any }[]) {
  const failed: { channel: (typeof channels)[number]; account: any; error: any }[] = [];
  for (const { channel, account } of items) {
    try {
      const record = await channel.checkinClaimOf!(account);
      const gain = typeof record.credits === 'number' ? ` +${record.credits}` : '';
      log(`checkin ${account.id}: ${record.status}${gain}${record.message ? ` (${record.message})` : ''}`);
      appendCheckinLog({
        ts: Date.now(),
        account: account.id,
        channel: channel.id,
        status: record.status,
        credits: typeof record.credits === 'number' ? record.credits : null,
        streakDays: typeof record.streakDays === 'number' ? record.streakDays : null,
        message: record.message ?? null,
        source: 'auto',
      });
      if (record.status === 'error' || record.status === 'pending') {
        failed.push({ channel, account, error: retryableError(record) });
      }
    } catch (error: any) {
      log(`checkin ${account.id} failed: ${error.message}`);
      appendCheckinLog({
        ts: Date.now(),
        account: account.id,
        channel: channel.id,
        status: 'error',
        message: error.message,
        source: 'auto',
      });
      failed.push({ channel, account, error });
    }
  }
  return failed;
}

export async function runOnce(): Promise<{ id: string }[]> {
  const today = localDate();
  const pending = pendingAccounts(today);
  if (pending.length === 0) {
    log('checkin 调度：今天没有待签账号（已签 / 已领 / 停用 / 凭据不可用）');
    return [];
  }
  const failed = await claimAll(pending);
  if (failed.length === 0) {
    log(`checkin 调度：${pending.length} 个待签账号本轮全部处理成功`);
    return [];
  }

  const delays = failed.some((item) => isTransient(item.error)) ? TRANSIENT_RETRY_DELAYS_MS : [retryDelay()];
  const ids = failed.map((item) => item.account.id).join(', ');
  log(`checkin 首次失败 ${failed.length} 个（${ids}），将在 ${delays.map((ms) => ms / 60000).join('/')} 分钟后依次重试`);

  const retryAt = (step: number, items: typeof failed) => {
    schedule(async () => {
      const stillPending = items.filter(({ channel, account }) => {
        const last = channel.lastCheckinOf?.(account) ?? null;
        return !settledForToday(last, today);
      });
      if (stillPending.length === 0) return;
      const again = await claimAll(stillPending);
      if (again.length > 0 && step + 1 < delays.length) retryAt(step + 1, again);
    }, delays[step]);
  };
  retryAt(0, failed);
  return failed.map((item) => ({ id: item.account.id }));
}

export function msUntilNextCheckin(now = new Date()): number {
  if (!isValidCheckinTime(config.checkinTime)) {
    return 60 * 60 * 1000;
  }
  const [hour, minute] = config.checkinTime.split(':').map(Number);
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  let diff = target.getTime() - now.getTime();
  if (diff < 0) diff += 24 * 60 * 60 * 1000;
  return diff;
}

export function startCheckinScheduler(): void {
  const now = new Date();
  const today = localDate(now);
  const shouldCatchUp = pendingAccounts(today).length > 0 && nowIsAfterCheckinTime(now);

  if (shouldCatchUp) {
    log('启动补签：今天还没签且已过签到点，先签一轮');
    runOnce().catch((error) => log(`签到调度失败：${error.message}`));
  }

  const arm = () => {
    const delay = msUntilNextCheckin();
    const timer = setTimeout(() => {
      runOnce().catch((error) => log(`签到调度失败：${error.message}`));
      arm();
    }, delay);
    timer.unref?.();
  };
  arm();
}

function nowIsAfterCheckinTime(now: Date): boolean {
  if (!isValidCheckinTime(config.checkinTime)) return false;
  const [hour, minute] = config.checkinTime.split(':').map(Number);
  return now.getHours() * 60 + now.getMinutes() >= hour * 60 + minute;
}

export async function checkinAllAccounts(): Promise<{ account: string; channel: string; status: string; credits?: number | null; message?: string | null }[]> {
  const results: { account: string; channel: string; status: string; credits?: number | null; message?: string | null }[] = [];
  for (const channel of channels) {
    if (typeof channel.checkinClaimOf !== 'function') continue;
    for (const account of accountsOf(channel.id)) {
      if (account.status !== 'ready') continue;
      try {
        const record = await channel.checkinClaimOf(account);
        const credits = typeof record.credits === 'number' ? record.credits : null;
        appendCheckinLog({
          ts: Date.now(),
          account: account.id,
          channel: channel.id,
          status: record.status,
          credits,
          streakDays: typeof record.streakDays === 'number' ? record.streakDays : null,
          message: record.message ?? null,
          source: 'manual',
        });
        results.push({ account: account.id, channel: channel.id, status: record.status, credits, message: record.message ?? null });
        const gain = typeof credits === 'number' ? ` +${credits}` : '';
        log(`checkin ${account.id}: ${record.status}${gain}${record.message ? ` (${record.message})` : ''}`);
      } catch (error: any) {
        appendCheckinLog({ ts: Date.now(), account: account.id, channel: channel.id, status: 'error', message: error.message, source: 'manual' });
        results.push({ account: account.id, channel: channel.id, status: 'error', message: error.message });
        log(`checkin ${account.id} failed: ${error.message}`);
      }
    }
  }
  return results;
}
