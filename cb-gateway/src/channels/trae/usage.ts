// Trae 的额度、每日签到，以及按请求结算消耗。
//
// 三件事都在账号 host（api.trae.cn）上，不在对话 host——对话是另一个服务。
// 接口契约是从 Trae CN 3.3.104 自己的渲染层还原、并用真实账号验证过的：
//
//   POST /trae/api/v2/pay/ide_user_ent_usage
//        {"require_usage": true, "req_source": 1}
//        -> { usage_summary: { total_amount, consumed_amount, consumption_ratio },
//             user_entitlement_pack_list: [...], is_credits_billing }
//
//   POST /trae/api/v2/ug/checkin_credits/status
//        {"req_source": 1}
//        -> { enable, checked_in, credits, extra_credits, did_checked_in }
//
//   POST /trae/api/v2/ug/checkin_credits/claim
//        {"req_source": 1}
//        -> { code: 0, message: "success" }   （幂等：今天已经领过也照样回 0）
//        -> { code: 9074, message: "当前参与用户太多，请稍后再试" }  ← 瞬时，重试有意义
//
// 鉴权和对话路由一样用 `Cloud-IDE-JWT <token>`。`x-device-id` 用 `effectiveDeviceId()`
// 挑出来的号（aha 注册号优先，没有就用自造号），见那个函数的说明。
//
// v2 起所有入口都收一个 `Account`，凡是「按账号攒下来的状态」都按账号分文件：
// 签到记录、额度缓存。v1 是通道级单份，两个号会互相污染——A 签过了 B 就不再签。

import type { Account, CheckinRecord, CheckinStatus, Credits } from '../../types.ts';
import { localDate } from '../../shared/clock.ts';
import { updateAccount, usableCredential } from '../../core/accounts.ts';
import { keepEarlierSuccess, readCheckinState, writeCheckinState } from '../../core/checkin-store.ts';
import { effectiveDeviceId, mintSelfDeviceId, refreshTraeCredential, TRAE_APP_VERSION } from './auth.ts';

const ACCOUNT_BASE = 'https://api.trae.cn';
const USAGE_PATH = '/trae/api/v2/pay/ide_user_ent_usage';
const CHECKIN_STATUS_PATH = '/trae/api/v2/ug/checkin_credits/status';
const CHECKIN_CLAIM_PATH = '/trae/api/v2/ug/checkin_credits/claim';

const USAGE_TTL_MS = 20_000;

let logSink: any = null;
export function setTraeUsageLogger(fn: any) {
  logSink = fn;
}
function log(...args: unknown[]) {
  if (logSink) logSink(`[trae-usage] ${args.join(' ')}`);
}

// ---------------------------------------------------------------- 传输

async function postAccount(account: Account, pathname: any, body: any) {
  const credential = await usableCredential(account, refreshTraeCredential);
  // 账号类接口（尤其是 claim）按 `x-device-id` 认设备。
  //
  // 优先用 aha 注册号（登录时若客户端注册过就带上），没有就用 `auth.ts` 自造的稳定号。
  // **不能为空**：实测空串打 claim 回 9004（`The submitted order parameters are
  // incorrect`），非空（哪怕 `1`、`abc`、16 位随机数）都放行。也别拿 `machineId`
  // （64 位十六进制遥测号）顶——它不是账号接口认的设备身份，服务端会回
  // `did_checked_in: false`。
  const deviceId = effectiveDeviceId(credential);
  const response = await fetch(`${ACCOUNT_BASE}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Cloud-IDE-JWT ${credential.token}`,
      'x-device-id': deviceId,
      // 版本号来自通道自述的 `appVersion`（product.json 的 appVersion，3.4.x），
      // **不是** product.json 的 version（1.107.1）——两者不是同一个字段。
      'x-app-version': TRAE_APP_VERSION,
      'x-device-type': 'windows',
      'x-os-version': 'Windows 10',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(`Trae account API returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`);
  }
  if (!response.ok) throw new Error(`Trae account API http ${response.status}: ${text.slice(0, 200)}`);
  if (typeof doc.code === 'number' && doc.code !== 0) {
    if (doc.code === 9004 && !deviceId) {
      throw withUpstreamCode(
        new Error(`Trae account API code 9004: ${doc.message || ''}（x-device-id 为空：这套凭据既没有 aha 注册号也没有自造号）`),
        doc.code,
      );
    }
    throw withUpstreamCode(new Error(`Trae account API code ${doc.code}: ${doc.message || ''}`), doc.code);
  }
  return doc;
}

/**
 * 上游业务码里**重试有意义**的那几个。
 *
 * 9074 = `当前参与用户太多，请稍后再试`。2026-11-11 / 11-12 实测：同一个账号、同一套
 * 请求头、同一个 `x-device-id`，00:09 连打三次都是 9074，隔 40 分钟再打就 `code 0`
 * 并真的发了 100 分（`did_checked_in` 只有真正领成的那个设备号才是 true）。所以它是
 * 上游活动侧的瞬时爆满，不是我们这边凭据、设备号或版本号的问题。
 */
const TRANSIENT_BIZ_CODES = new Set([9074]);

/**
 * 遇到 9074 时**当场换设备号再打一次**，最多换几轮。
 *
 * ## 为什么要换号重试
 *
 * 用户 2026-11-14 的实测：tr-3 当天 10:05 / 10:15 / 10:45 / 11:45 四次 9074，
 * 换掉 `selfDeviceId` 后**第一次请求就成功**（+100）。9074 的文案是「参与用户太多」，
 * 但服务端显然也按设备维度在做限流/编排——换一个设备身份能绕开它这一轮的排队。
 *
 * ## 为什么只有 2 轮
 *
 * 换号不是万能药（2026-11-13 那天同一个号早上全挂、下午自己就过了），而且每轮要打
 * 一次 status + 一次 claim。2 轮是「给一次机会，但不把上游打满」的折中；剩下的靠
 * 调度器的重试阶梯，那一层有真正的退避。
 */
const ROTATE_ON_9074_ROUNDS = 2;

/** 把「换设备号」这件事落到凭据上（内存 + 库同时更新，走账号层的 `persist`）。 */
function rotateCheckinDevice(account: Account): string | null {
  // aha 真号存在时它优先，换自造号不生效——那种情况换号没有意义，直接返回 null
  // 让调用方老实按失败处理，不要给出「我换了但没用」的假象。
  if (typeof account.credential?.checkinDeviceId === 'string' && account.credential.checkinDeviceId !== '') {
    return null;
  }
  const next = mintSelfDeviceId();
  const credential = { ...(account.credential || {}), selfDeviceId: next };
  // 先改内存里的这一份：`postAccount` 读的就是传进来的 `account.credential`，
  // 这一轮后续请求必须立刻用上新号。
  account.credential = credential;
  // 再落库，否则重启回到旧号——那等于每次重启都白换一次。
  if (!updateAccount(account.id, { credential })) {
    log(`${account.id} 换号后写库失败（账号不在库里？），本次仍用 ${next}`);
  }
  log(`${account.id} 9074 → 换设备号 ${next} 后重试`);
  return next;
}

/** 把上游业务码挂到错误对象上：调度器据此区分「等一会再试」和「今天算了」。 */
function withUpstreamCode(error: Error, code: number) {
  const tagged: any = error;
  tagged.upstreamCode = code;
  tagged.transient = TRANSIENT_BIZ_CODES.has(code);
  return tagged;
}

// ---------------------------------------------------------------- 额度

const usageCache = new Map<string, { at: number; value: any }>();
const usageInFlight = new Map<string, Promise<any>>();

/**
 * 积分快照。`remaining` 是算出来的，不是上游给的：Trae 只报 `total_amount` 和
 * `consumed_amount`，没有余额字段。
 */
export async function getTraeUsage(account: Account, options: { force?: boolean } = {}): Promise<Credits> {
  const cached = usageCache.get(account.id);
  if (!options.force && cached && cached.value && Date.now() - cached.at < USAGE_TTL_MS) return cached.value;
  const running = usageInFlight.get(account.id);
  if (running) return running;
  const task = (async () => {
    const doc = await postAccount(account, USAGE_PATH, { require_usage: true, req_source: 1 });
    const summary = doc.usage_summary && typeof doc.usage_summary === 'object' ? doc.usage_summary : {};
    const total = Number(summary.total_amount) || 0;
    const consumed = Number(summary.consumed_amount) || 0;
    const packs = Array.isArray(doc.user_entitlement_pack_list) ? doc.user_entitlement_pack_list : [];
    const value = {
      provider: account.channelId,
      supported: true,
      currency: 'credits',
      total,
      consumed: Number(consumed.toFixed(4)),
      remaining: Number(Math.max(0, total - consumed).toFixed(4)),
      // 徽标只读这一个数字，统一成和另两个通道一样的字段名。
      totalRemain: Number(Math.max(0, total - consumed).toFixed(4)),
      ratio: Number(summary.consumption_ratio) || (total > 0 ? consumed / total : 0),
      isCreditsBilling: doc.is_credits_billing === true,
      trial: doc.trial_status && typeof doc.trial_status === 'object' ? doc.trial_status : null,
      packages: packs
        .filter((pack: any) => pack && typeof pack === 'object' && pack.is_hide !== true)
        .map((pack: any) => {
          const base = pack.entitlement_base_info && typeof pack.entitlement_base_info === 'object' ? pack.entitlement_base_info : {};
          const quota = base.quota && typeof base.quota === 'object' ? base.quota : {};
          const used = pack.usage && typeof pack.usage === 'object' ? pack.usage : {};
          return {
            name: typeof pack.display_desc === 'string' && pack.display_desc !== '' ? pack.display_desc : (base.product_extra?.package_extra?.package_name || '积分包'),
            limit: Number(quota.credits_limit) || 0,
            used: Number(used.credits_amount) || 0,
            expireAt: Number(pack.expire_time) ? Number(pack.expire_time) * 1000 : null,
            group: typeof pack.group_name === 'string' ? pack.group_name : '',
          };
        }),
      fetchedAt: Date.now(),
    };
    usageCache.set(account.id, { at: Date.now(), value });
    return value;
  })();
  usageInFlight.set(account.id, task);
  try {
    return await task;
  } finally {
    usageInFlight.delete(account.id);
  }
}

function invalidateTraeUsage(account: Account) {
  usageCache.delete(account.id);
}

// ---------------------------------------------------------------- 签到

// 本地签到状态的读写统一在 `core/checkin-store.ts`。

export async function getCheckinStatus(account: Account): Promise<CheckinStatus> {
  const doc = await postAccount(account, CHECKIN_STATUS_PATH, { req_source: 1 });
  return {
    enable: doc.enable === true,
    checkedIn: doc.checked_in === true,
    credits: Number(doc.credits) || 0,
    extraCredits: Number(doc.extra_credits) || 0,
    didCheckedIn: doc.did_checked_in === true,
  };
}

/**
 * 领今天的积分。上游本身幂等；本地记录要保证「今天已经成功过一次」不会被后来
 * 一次失败覆盖掉。
 *
 * 失败**不抛异常**，而是返回一条 `status: 'error'` 的记录：这里必须先重查一次上游
 * 状态（见下面的 catch），确认不是「我们报错、服务端其实已经签到」。失败值不值得
 * 密集重试，由返回对象上的 `transient` 告诉调度器（`TRANSIENT_BIZ_CODES` 里的 9074）。
 *
 * ## 9074 会当场换设备号再试
 *
 * 见 `ROTATE_ON_9074_ROUNDS`：遇到 9074 就换一个 `selfDeviceId` 重新走一遍领取，
 * 最多换 2 轮。换号会写进账号凭据（持久化），所以下次签到用的就是新号。
 * 换完还失败就照常返回 error + `transient: true`，交给调度器的退避阶梯。
 */
export async function claimCheckin(account: Account): Promise<CheckinRecord> {
  let last: CheckinRecord = await claimOnce(account);
  for (let round = 0; round < ROTATE_ON_9074_ROUNDS; round += 1) {
    // 只有「确实因为 9074 失败、且今天还没签成」才值得换号重来。
    // `already` / `checked` / `disabled` 都是结论，再去打只会多算一次请求。
    if (last.status !== 'error' || last.transient !== true || last.upstreamCode !== 9074) break;
    // 换号失败（有 aha 真号、换不动）就别硬撑，直接按失败返回。
    if (rotateCheckinDevice(account) === null) break;
    last = await claimOnce(account);
  }
  return last;
}

/**
 * 跑**一轮**领取：读状态 → 没签就领 → 再读状态定结论。
 *
 * 抽出来是为了让 9074 的「换号重来」复用同一段逻辑——两处各写一遍的话，某天改了
 * 失败判据只改一处，另一处就会静默给出不一样的结论。
 */
async function claimOnce(account: Account): Promise<CheckinRecord> {
  const today = localDate();
  let outcome: CheckinRecord;
  // 只有 error 分支可能是 transient：9074 那种「活动瞬时爆满」等一会再试有意义，
  // 其余失败（凭据、参数）重试也是白打。默认 false。
  let transient = false;
  let upstreamCode: number | undefined;
  try {
    const status = await getCheckinStatus(account);
    if (!status.enable) {
      outcome = { date: today, status: 'disabled', message: 'Trae 未开放签到', at: Date.now() };
    } else if (status.checkedIn) {
      outcome = {
        date: today,
        status: 'already',
        credits: status.credits,
        message: '今天已签到',
        at: Date.now(),
      };
    } else {
      const doc = await postAccount(account, CHECKIN_CLAIM_PATH, { req_source: 1 });
      // 重新读一次状态，让记录带上服务端实际发了多少，而不是领取前的预览值。
      // 重读失败不能把一次成功的领取变成错误。
      const after = await getCheckinStatus(account).catch(() => null);
      outcome = {
        date: today,
        status: 'checked',
        credits: after ? after.credits : status.credits,
        extraCredits: after ? after.extraCredits : status.extraCredits,
        message: doc.message || '签到成功',
        at: Date.now(),
      };
      log(`${account.id} checkin success credits=${outcome.credits} extra=${outcome.extraCredits}`);
      invalidateTraeUsage(account);
    }
  } catch (error: any) {
    // 领取报错不代表今天没领到：9074 那种瞬时爆满、或者别的入口（用户自己开客户端）
    // 刚好在同一个时段领掉了，都会出现「我们这里抛错、服务端却是已签到」。所以失败后
    // 再看一眼状态，已签到就记 `already`，别在面板上留一条假的「失败」。
    const after = await getCheckinStatus(account).catch(() => null);
    if (after && after.checkedIn) {
      outcome = {
        date: today,
        status: 'already',
        credits: after.credits,
        extraCredits: after.extraCredits,
        message: '今天已签到',
        at: Date.now(),
      };
      log(`${account.id} checkin 报错但服务端已签到（${error.message}），按已签到记`);
    } else {
      outcome = { date: today, status: 'error', message: error.message, at: Date.now() };
      transient = error.transient === true;
      upstreamCode = typeof error.upstreamCode === 'number' ? error.upstreamCode : undefined;
      log(`${account.id} checkin error: ${error.message}`);
    }
  }

  // 网络抖一下不该把今天早些时候那次成功（唯一存着积分的地方）抹掉。
  const earlier = keepEarlierSuccess(account, today, outcome);
  if (earlier) return { ...earlier, outcome: outcome.status, transient, upstreamCode };

  if (!writeCheckinState(account, outcome)) log(`${account.id} checkin state write failed`);
  return { ...outcome, outcome: outcome.status, transient, upstreamCode };
}

export function readLastCheckin(account: Account): CheckinRecord | null {
  return readCheckinState(account);
}
