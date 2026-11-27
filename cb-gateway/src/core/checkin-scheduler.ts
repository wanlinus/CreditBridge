// 每日签到调度：到点签一次，失败 1 小时后重试一次，再失败就放弃。
//
// **通道把失败吞成 `status: 'error'` 记录返回、不抛异常**（它得先重查上游确认不是「我们
// 报错但服务端已签到」），所以重试阶梯必须判返回值，只看 `catch` 会让真实失败一个都进不了
// 阶梯（2026-11-11 的 9074 就是这么漏的：10/30/60 分钟都没有重试）。

import { channels } from '../channels/index.ts';
import { accountsOf } from './accounts.ts';
import { log } from '../logger.ts';
import { localDate } from '../shared/clock.ts';
import { config, isValidCheckinTime } from '../config.ts';
import { appendCheckinLog, skippedLoggedToday } from './checkin-log.ts';
import { refreshAllVersions } from './channel-versions.ts';

const RETRY_DELAY_MS = 60 * 60 * 1000;

/** 错误被标成 `transient` 时的阶梯：Trae 的 9074 实测能持续半小时以上，1 小时一次撞不上窗口。 */
const TRANSIENT_RETRY_DELAYS_MS = [10 * 60 * 1000, 30 * 60 * 1000, 60 * 60 * 1000];

const testHooks: { retryDelayMs?: number; setTimeout?: typeof setTimeout } = {};

/** 把重试延迟和定时器换成假的。 */
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

/**
 * 今天这次是不是已经有结论了：`checked` / `already` / `disabled` 都算。
 *
 * **`pending` 不算**——那是「今天这一轮还没开始」（Qoder 的活动每天 10:00 才开窗口），
 * 当成有结论就会永久放弃今天。
 */
function settledForToday(last: { date?: string; status?: string } | null, today: string): boolean {
  if (!last || last.date !== today) return false;
  return last.status === 'checked' || last.status === 'already' || last.status === 'disabled';
}

/** 今天还没签到、状态是 `ready` 的账号。 */
function pendingAccounts(today: string) {
  const out: { channel: (typeof channels)[number]; account: ReturnType<typeof accountsOf>[number] }[] = [];
  for (const channel of channels) {
    if (typeof channel.checkinClaimOf !== 'function') continue;
    for (const account of accountsOf(channel.id)) {
      // 只给 `ready` 的号签：`invalid` / `disabled` 的号打过去只会多一条失败。
      if (account.status !== 'ready') continue;
      const last = channel.lastCheckinOf?.(account) ?? null;
      if (settledForToday(last, today)) continue;
      // 关掉的号要留一行日志，否则「关掉了」和「调度器没跑」在日志里一样；每天只记一次。
      if (!account.checkinEnabled) {
        if (!skippedLoggedToday(account.id, today)) {
          appendCheckinLog({
            ts: Date.now(),
            account: account.id,
            channel: channel.id,
            status: 'skipped',
            message: '这个号的自动签到关着',
            source: 'auto',
          });
          log(`checkin ${account.id}: skipped（自动签到关着）`);
        }
        continue;
      }
      out.push({ channel, account });
    }
  }
  return out;
}

function isTransient(error: any): boolean {
  return Boolean(error) && error.transient === true;
}

/** 把「通道返回的 error 记录」包成失败对象，`transient` 要带过来。 */
function retryableError(record: { message?: string | null; transient?: boolean }): any {
  return Object.assign(new Error(record.message || '签到失败'), { transient: record.transient === true });
}

/** 对一批账号逐个签，返回失败的那批。异常和 error 记录两种形态都收。 */
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
      // `pending` 也要进重试：09:00 那轮 pending、10:00 之后重试正好能领到。
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

/** 跑一轮签到，失败的按延迟阶梯重试；阶梯走完就到此为止。 */
export async function runOnce(): Promise<{ id: string }[]> {
  const today = localDate();
  const pending = pendingAccounts(today);
  if (pending.length === 0) {
    // 「今天没号可签」也要留一行：不写的话，「跑过但无事可做」和「根本没触发」在日志里
    // 长得一模一样，2026-11-12 只能靠容器启动时间去反推。
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
      // 重试前再看一眼：也许用户已经手动签了。
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

/** 到下一个签到时间点还差多少毫秒（本地时间，和 `localDate` 同口径）。导出给测试传 `now`。 */
export function msUntilNextCheckin(now = new Date()): number {
  if (!isValidCheckinTime(config.checkinTime)) {
    // 配置坏了就退回一小时后再试，别让调度停掉。
    return 60 * 60 * 1000;
  }
  const [hour, minute] = config.checkinTime.split(':').map(Number);
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  let diff = target.getTime() - now.getTime();
  // 严格小于 0 才算「今天的点已过」：等于 0 要立即触发，否则整点启动会漏签今天。
  if (diff < 0) diff += 24 * 60 * 60 * 1000;
  return diff;
}

/** 先判断要不要补签，再挂一个到点的定时器。两轮重叠靠 `already` 消掉。 */
export function startCheckinScheduler(): void {
  const now = new Date();
  const today = localDate(now);
  // `msUntilNextCheckin` 恒正，不能当「过没过点」的判据，那要用 `nowIsAfterCheckinTime`。
  const shouldCatchUp = pendingAccounts(today).length > 0 && nowIsAfterCheckinTime(now);

  if (shouldCatchUp) {
    log('启动补签：今天还没签且已过签到点，先签一轮');
    runOnce().catch((error) => log(`签到调度失败：${error.message}`));
  }

  // 版本号顺手在这一轮里查：**不另开定时器**。上游客户端自己也是几小时检查一次，
  // 跟着签到的日节奏走足够，而且少一个长期定时任务就少一处泄漏和调试面。
  // 启动时先跑一次：新部署拿不到最新版本就没意义。
  refreshAllVersions().catch((error) => log(`版本刷新失败：${error.message}`));

  const arm = () => {
    const delay = msUntilNextCheckin();
    const timer = setTimeout(() => {
      runOnce().catch((error) => log(`签到调度失败：${error.message}`));
      // 和签到同一轮里跑，互不阻塞：版本查不到不影响签到。
      refreshAllVersions().catch((error) => log(`版本刷新失败：${error.message}`));
      arm(); // 签完这一轮，重新算下一个点（明天的点）
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

/**
 * 「一键签到」：签所有 `ready` 账号。和调度器有三处不同——不跳过今天已签的、不重试、
 * `source=manual`。**开关不拦手动**：开关的意思是「别自动签」，用户点按钮是显式意图。
 */
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
