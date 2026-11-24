// 每日签到调度：每天在配置的时间点签一次，失败 1 小时后重试一次，再失败就放弃。
//
// v1 是每个通道各起一个定时器（`startCheckinScheduler()` 挂在通道的 `start()` 上）。
// v2 账号是**数据**，通道不知道有几个号——调度只能放在上面这一层，否则加个通道就要
// 记得再写一份调度，而漏掉的表现是「那个通道永远不签到」。
//
// 触发语义（和「每 30 分钟轮询」不一样，2026-11 改的）：
//   · 计算距离今天 `checkinTime` 的毫秒数，`setTimeout` 精确到点；
//   · 到点签一次，某个账号失败就记下，1 小时后只对失败的账号再试一次；
//   · 再失败就放弃（当天不再签），等明天的点。
//   · 启动时若今天还没签、且当前时间已经过了签到点，立即补签一次（机器在点上关着
//     也能补上），但同样只给「一次 + 一次重试」。
//
// **例外：通道把错误标成 `transient` 时走密集阶梯**（10 / 30 / 60 分钟各一次）。
// Trae 的 9074（活动瞬时爆满）实测能持续半小时以上，一次 1 小时后的重试撞不上窗口；
// 而这类错误重试本身无害（领取是幂等的），所以值得多打几次。判据是错误对象上的
// `transient` 标志，不看是哪个通道——通道自己知道自己哪个码值得重试。
//
// 幂等由通道保证（领过的返回 `already`），本地记录由通道写。

import { channels } from '../channels/index.ts';
import { accountsOf } from './accounts.ts';
import { log } from '../logger.ts';
import { localDate } from '../shared/clock.ts';
import { config, isValidCheckinTime } from '../config.ts';
import { appendCheckinLog, skippedLoggedToday } from './checkin-log.ts';

const RETRY_DELAY_MS = 60 * 60 * 1000;

/** 错误被标成 `transient` 时的重试阶梯：覆盖「上游活动爆满」那种半小时量级的窗口。 */
const TRANSIENT_RETRY_DELAYS_MS = [10 * 60 * 1000, 30 * 60 * 1000, 60 * 60 * 1000];

/** 测试注入点：把「重试延迟」「定时器」换成假的，好测时序。 */
const testHooks: { retryDelayMs?: number; setTimeout?: typeof setTimeout } = {};

/** 测试用：注入重试延迟和定时器实现，之后 `resetSchedulerHooksForTests()` 还原。 */
export function setSchedulerHooksForTests(hooks: { retryDelayMs?: number; setTimeout?: typeof setTimeout }): void {
  Object.assign(testHooks, hooks);
}

/** 测试用：还原注入点。 */
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
 * 今天这次是不是已经有结论了。
 *
 * `checked` / `already` / `disabled` 都算有结论：
 *   - `checked`  领到了
 *   - `already`  今天已经领过
 *   - `disabled` 上游**永久**不开放签到（Trae 的活动下线了），今天再试也没用
 *
 * **`pending` 不算**：那是「今天这一轮还没开始」（Qoder 的活动每天 10:00 才开窗口），
 * 窗口开了还要再试。它的重试靠 `runOnce()` 的阶梯——`pending` 的记录会被
 * `retryableError()` 包成可重试的错误，走普通的一次重试。
 */
function settledForToday(last: { date?: string; status?: string } | null, today: string): boolean {
  if (!last || last.date !== today) return false;
  return last.status === 'checked' || last.status === 'already' || last.status === 'disabled';
}

/** 拿一份「今天还没签到、且状态是 ready」的账号清单。 */
function pendingAccounts(today: string) {
  const out: { channel: (typeof channels)[number]; account: ReturnType<typeof accountsOf>[number] }[] = [];
  for (const channel of channels) {
    if (typeof channel.checkinClaimOf !== 'function') continue;
    for (const account of accountsOf(channel.id)) {
      // 只给 `ready` 的号签：`disabled` 是用户主动停用，`invalid` 的凭据签不动，
      // `cooldown` 正在限流——这时候再打一次只会让恢复时间更远。
      if (account.status !== 'ready') continue;
      const last = channel.lastCheckinOf?.(account) ?? null;
      if (settledForToday(last, today)) continue;
      // 开关关掉就跳过，但留一条日志：不然「关掉了」和「调度器没跑」在日志里一样。
      // 每天只记一次——`runOnce()` 一天跑好几轮，每轮都记会把日志刷满。
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

/** 这个错误值不值得密集重试（通道在抛错时自己打的标记）。 */
function isTransient(error: any): boolean {
  return Boolean(error) && error.transient === true;
}

/**
 * 把「通道返回的 error 记录」包装成调度器认识的那种失败对象。
 *
 * **异常不是失败的唯一形态**：三个通道的 `claimCheckin` 都是把异常吞成一条
 * `status: 'error'` 记录再返回的——它们必须先重查一次上游状态，确认不是「我们报错、
 * 服务端其实已经签到」，所以不能在通道里直接抛。2026-11-12 之前 `claimAll` 只看
 * `catch`，于是真实失败一个都进不了重试阶梯：`transient` 标志打了，`delays` 那段
 * 却永远走不到（日志实证：11-11 09:00 那次 9074 之后 10/30/60 分钟都没有重试）。
 */
function retryableError(record: { message?: string | null; transient?: boolean }): any {
  return Object.assign(new Error(record.message || '签到失败'), { transient: record.transient === true });
}

/**
 * 对一批账号逐个签，返回「失败」的那批（带可重试的错误对象），供重试。
 *
 * 失败有两种形态，两种都收：通道**抛异常**，以及通道**返回 `status: 'error'` 记录**
 * （三个通道的真实形态，理由见 `retryableError`）。
 */
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
      // 通道用返回值表达失败（见 `retryableError` 的注释），所以这条路径也要收失败。
      //
      // **`pending` 也进重试**：那是「今天这一轮还没开始」（Qoder 的活动每天 10:00 开窗口）。
      // 它不是失败，但也不能当成「今天结束了」——窗口开了要再试一次。走普通重试阶梯
      // （1 小时后一次）正好覆盖：09:00 那轮 `pending`，10:00 之后那次重试就能领到。
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

/**
 * 跑一轮签到：签一遍，失败的按延迟阶梯重试。
 *
 * 延迟阶梯分两种：
 *   · 普通错误 → `[retryDelay()]`，即「1 小时后再试一次就放弃」；
 *   · 有账号报 `transient` 错误 → `TRANSIENT_RETRY_DELAYS_MS`（10/30/60 分钟各一次），
 *     因为上游活动爆满这类窗口本身就是半小时量级，一小时一次撞不上。
 *
 * 两种都不会无限重试：阶梯走完就到此为止，明天的点再来。
 *
 * 返回首次那批失败账号，测试据此断言「失败被记下、且只重试约定的次数」。
 */
export async function runOnce(): Promise<{ id: string }[]> {
  const today = localDate();
  const pending = pendingAccounts(today);
  if (pending.length === 0) {
    // 「今天没号可签」也要留一行：2026-11-12 排查「今天的自动签到怎么没跑」时，
    // 「调度器跑过、只是无事可做」和「调度器根本没触发」在日志里长得一模一样，
    // 只能靠容器启动时间、state 文件时间戳这些旁证反推。这一行留给下一个查的人。
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
      // 重试前再看一眼：也许用户已经在面板上手动签了。
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

/**
 * 到下一个签到时间点还差多少毫秒（用本地时间算，和 `localDate` 同口径）。
 *
 * 导出是给测试用的：测试直接传一个 `now`，断言「9:05 时离 09:00 还有 23 小时 55 分」
 * 这类边界，不用真的等一天。
 */
export function msUntilNextCheckin(now = new Date()): number {
  if (!isValidCheckinTime(config.checkinTime)) {
    // 配置坏了就退回一小时后再试，别让它把调度停掉。
    return 60 * 60 * 1000;
  }
  const [hour, minute] = config.checkinTime.split(':').map(Number);
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  let diff = target.getTime() - now.getTime();
  // 严格小于 0 才是「今天的点已过」。等于 0（正好踩在点上）要立即触发，不能推到明天，
  // 否则恰好整点启动会漏签今天。
  if (diff < 0) diff += 24 * 60 * 60 * 1000;
  return diff;
}

/**
 * 启动调度器。
 *
 * 逻辑：先判断「现在要不要补签」（今天没签、且时间已过签到点），要就立即签；然后
 * 挂一个到点的定时器。签完（无论成功失败）都会在到点时再正常走一次——补签那轮
 * 已经把失败的重试排好了，正常到点那轮又会给「今天仍没签」的号再签一次，两轮重叠
 * 时靠通道的幂等（`already`）消掉，不会重复领。
 */
export function startCheckinScheduler(): void {
  const now = new Date();
  const today = localDate(now);
  // 补签条件：今天还没签 + 现在已经过了（或正赶上）签到点。`msUntilNextCheckin` 恒正，
  // 不能当「过没过点」的判据，那要用 `nowIsAfterCheckinTime`。
  const shouldCatchUp = pendingAccounts(today).length > 0 && nowIsAfterCheckinTime(now);

  if (shouldCatchUp) {
    log('启动补签：今天还没签且已过签到点，先签一轮');
    runOnce().catch((error) => log(`签到调度失败：${error.message}`));
  }

  const arm = () => {
    const delay = msUntilNextCheckin();
    const timer = setTimeout(() => {
      runOnce().catch((error) => log(`签到调度失败：${error.message}`));
      arm(); // 签完这一轮，重新算下一个点（明天的点）
    }, delay);
    timer.unref?.();
  };
  arm();
}

/** 当前时刻是不是已经过了今天的签到点。 */
function nowIsAfterCheckinTime(now: Date): boolean {
  if (!isValidCheckinTime(config.checkinTime)) return false;
  const [hour, minute] = config.checkinTime.split(':').map(Number);
  return now.getHours() * 60 + now.getMinutes() >= hour * 60 + minute;
}

/**
 * 「一键签到」：签所有 `ready` 账号，返回每个账号的结果。
 *
 * 和 `runOnce()`（调度那套）的区别有三点，都来自「这是用户手动点的」：
 *   · **不跳过今天已签的**——用户点「一键签到」想看每个号现在的状态，已签的返回
 *     `already` 也照样列出，而不是像调度器那样静默跳过；
 *   · **不重试**——点一下要立刻看到结果，失败就失败（日志里能看到），不会 1 小时后
 *     再来一次；
 *   · **source=manual**——日志里能区分是用户点的还是调度器自动跑的。
 *
 * 状态过滤和调度器一致：只签 `ready` 的号（disabled/invalid/cooldown 跳过），
 * 只签实现了 `checkinClaimOf` 的通道。
 *
 * **但两级开关不拦手动**：开关的意思是「别自动签」，不是「不许签」。用户点了按钮就是
 * 显式意图，要让他能补一次——比如 Qoder 的开关关着、某天上游临时开了活动想手动领。
 * 自动和手动的差别只体现在 `source` 字段上。
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
