// 账号的管理面：`/api/accounts/*`（JSON）。
//
// v1 没有这个模块——账号是通道自带的单例，加号就是改配置文件。v2 一个通道挂 N 个号，
// 「加号」变成一次交互式登录，必须有个地方起任务、轮询进度、改标签、停用、删除。
//
// **没有页面层了**（2026-11-13 SPA 转正）：旧的 `/accounts` 页面连同它的 8 个表单动作
// 一起删掉，界面在 `web/src/views/AccountsView.vue`。
//
// 认证：全在 `auth/middleware.ts` 的闸后面（Bearer 或会话 Cookie）。

import { Hono } from 'hono';

import type { AppEnv } from '../app.ts';
import type { Account } from '../types.ts';
import { channelById, channels } from '../channels/index.ts';
import { accountsOf, getAccount, listAccounts, markInvalid, markReady, removeAccount, setStatus, updateAccount } from '../core/accounts.ts';
import { capabilitiesOf } from '../core/channel-info.ts';
import { accountsWithSpend, buildCredits, refreshCredits } from '../core/credits.ts';
import { buildBadge } from '../core/badge.ts';
import { appendCheckinLog } from '../core/checkin-log.ts';
import { answerLoginPrompt, getLoginTask, publicTask, startLogin } from '../core/login-tasks.ts';
import { usageSummary } from '../ledger.ts';
import { log } from '../logger.ts';
import { isCredentialError } from '../shared/credential-error.ts';
import { readJsonBody } from '../shared/json-body.ts';

export const accountsRoutes = new Hono<AppEnv>();

const CHANNEL_IDS = channels.map((channel) => channel.id);

/** 从注册表 + 账号层拼出「账号 + 它属于哪个通道」。查不到通道的账号直接跳过。 */
function accountWithChannel(id: string): { account: Account; channel: NonNullable<ReturnType<typeof channelById>> } | null {
  const account = getAccount(id);
  const channel = account ? channelById(account.channelId) : undefined;
  return account && channel ? { account, channel } : null;
}

// ---------------------------------------------------------------- JSON API

accountsRoutes.get('/api/accounts', async (c) => {
  const accounts = listAccounts(CHANNEL_IDS);
  // 组装逻辑和界面共用 `accountsWithSpend()`：几处各写一遍的话，键名拼错的表现是
  // 「某个页面的今日用量全是 0」，而账本里明明有数——不报错，只能靠人眼发现。
  const { credits, tokensToday, tokensTotal } = await accountsWithSpend(accounts);
  return c.json({
    accounts: accounts.map((account) => {
      const snapshot = credits[account.id];
      return {
        id: account.id,
        channelId: account.channelId,
        channelLabel: channelById(account.channelId)?.label || account.channelId,
        idPrefix: channelById(account.channelId)?.idPrefix || '',
        seq: account.seq,
        label: account.label,
        status: account.status,
        statusMessage: account.statusMessage,
        cooldownUntil: account.cooldownUntil,
        profile: account.profile,
        createdAt: account.createdAt,
        // ---- 积分（官方口径，只读。各通道的叫法和重置规则都不同，**不可跨通道相加**）----
        totalRemain: snapshot?.remain ?? null,
        /** 官方给的「已用」。`null` = 该通道不提供（界面上显示 `—`，不是 0）。 */
        usedTotal: snapshot?.used ?? null,
        /** 官方给的「总额度」。 */
        limitTotal: snapshot?.limit ?? null,
        /** 上一次真实读取上游时的剩余，用来显示「较上次 ±X」。 */
        prevRemain: snapshot?.prevRemain ?? null,
        prevAt: snapshot?.prevAt ?? null,
        creditsAt: snapshot?.at ?? null,
        // ---- 用量（网关账本统计，token 可跨通道相加）----
        todayTokens: tokensToday[account.id] ?? 0,
        totalTokens: tokensTotal[account.id] ?? 0,
        /** 这个号的自动签到开关。 */
        checkinEnabled: account.checkinEnabled,
      };
    }),
    channels: channels.map((channel) => ({
      id: channel.id,
      label: channel.label,
      idPrefix: channel.idPrefix,
      multiAccount: channel.multiAccount !== false,
      // 能力位是**自述**的，且只有 `core/channel-info.ts` 一个来源：界面用它们决定
      // 按钮显不显示，而不是在前端写一份通道清单（AGENTS.md 的硬约束）。三处响应
      // 各抄一遍的话，加第五个能力位时必然漏一处，而漏掉的表现是「按钮永远不出现」。
      ...capabilitiesOf(channel),
      /**
       * 上游会不会报 token 用量。`false` 的通道在账本里恒为 0，界面上要显示 `—`
       * 而不是 0——「统计不到」和「确实没用过」是两回事。
       */
      reportsTokens: channel.reportsTokens !== false,
      accounts: accountsOf(channel.id).map((account) => account.id),
    })),
  });
});

accountsRoutes.post('/api/accounts/:channel/login', (c) => {
  const channel = channelById(c.req.param('channel'));
  if (!channel) return c.json({ error: { message: `没有通道 ${c.req.param('channel')}`, type: 'not_found' } }, 404);
  const result = startLogin(channel);
  if (!result.ok || !result.task) return c.json({ error: { message: result.error || '登录启动失败', type: 'bad_request' } }, 400);
  return c.json({ ok: true, task: publicTask(result.task) });
});

accountsRoutes.get('/api/accounts/:channel/login/:taskId', (c) => {
  const task = getLoginTask(c.req.param('channel'), c.req.param('taskId'));
  if (!task) return c.json({ error: { message: '没有这个登录任务（可能已过期，重新发起一次）', type: 'not_found' } }, 404);
  return c.json(publicTask(task));
});

/**
 * 表单式登录（Loomy 短信验证码）：用户提交一个输入，回填给正在等输入的 prompt。
 *
 * 形状 `{value}`。通道拿到值之后要么发下一个 prompt、要么完成登录，两者都会反映在
 * 任务快照里，前端下一次轮询自然看到——这里不回任务状态，避免两个地方各维护一份。
 */
accountsRoutes.post('/api/accounts/:channel/login/:taskId/answer', async (c) => {
  const channelId = c.req.param('channel');
  const taskId = c.req.param('taskId');
  const parsed = await readJsonBody(c);
  if (!parsed.ok) return c.json({ error: { message: parsed.message, type: 'bad_request' } }, 400);
  const value = typeof parsed.body.value === 'string' ? parsed.body.value.trim() : '';
  if (!value) return c.json({ error: { message: '需要一个 value', type: 'bad_request' } }, 400);
  if (!getLoginTask(channelId, taskId)) {
    return c.json({ error: { message: '没有这个登录任务', type: 'not_found' } }, 404);
  }
  if (!answerLoginPrompt(channelId, taskId, value)) {
    return c.json({ error: { message: '这个任务当前不在等输入', type: 'bad_request' } }, 400);
  }
  return c.json({ ok: true });
});

/** 检测凭据还能不能用（会真的打一次上游，所以不放进 `/health`）。 */
accountsRoutes.post('/api/accounts/:id/verify', async (c) => {
  const found = accountWithChannel(c.req.param('id'));
  if (!found) return c.json({ error: { message: `没有账号 ${c.req.param('id')}`, type: 'not_found' } }, 404);
  if (typeof found.channel.probe !== 'function') {
    return c.json({ error: { message: `${found.channel.label} 没有实现凭据检测`, type: 'bad_request' } }, 400);
  }
  try {
    const profile = await found.channel.probe(found.account);
    updateAccount(found.account.id, { profile: { ...found.account.profile, ...profile } });
    markReady(found.account.id);
    return c.json({ ok: true, profile });
  } catch (error: any) {
    // 「检测」是用户主动验活，正是最该让状态反映真实情况的地方：凭据永久失效就标
    // invalid，管理台上那个号立刻变成「凭据失效」，而不是继续显示「就绪」。
    // 暂时性故障（网络 / 上游 5xx）只回报错误，不动状态。
    if (isCredentialError(error) && error.permanent) markInvalid(found.account.id, error.message);
    return c.json({ error: { message: error.message, type: 'upstream_error' } }, 502);
  }
});

accountsRoutes.patch('/api/accounts/:id', async (c) => {
  const found = accountWithChannel(c.req.param('id'));
  if (!found) return c.json({ error: { message: `没有账号 ${c.req.param('id')}`, type: 'not_found' } }, 404);
  const parsed = await readJsonBody(c);
  if (!parsed.ok) return c.json({ error: { message: parsed.message, type: 'bad_request' } }, 400);
  const body = parsed.body;
  if (typeof body.label === 'string' && body.label.trim() !== '') {
    updateAccount(found.account.id, { label: body.label.trim() });
  }
  if (typeof body.status === 'string') {
    if (body.status === 'disabled' || body.status === 'ready') {
      setStatus(found.account.id, body.status, { message: body.status === 'disabled' ? '管理台手动停用' : undefined });
    } else {
      // cooldown / invalid 是网关自己根据上游反应写进去的，不接受外部直接指定——
      // 手动设一个「凭据失效」只会让人以为真坏了。
      return c.json({ error: { message: `不能把账号状态直接设成 ${body.status}`, type: 'bad_request' } }, 400);
    }
  }
  const next = getAccount(found.account.id);
  return c.json({ ok: true, account: next });
});

accountsRoutes.delete('/api/accounts/:id', (c) => {
  const id = c.req.param('id');
  if (!removeAccount(id)) return c.json({ error: { message: `没有账号 ${id}`, type: 'not_found' } }, 404);
  log(`账号 ${id} 已删除`);
  return c.json({ ok: true, removed: id });
});

// ---------------------------------------------------------------- 账号子资源（面板用）

/**
 * 单账号详情。
 *
 * **为什么不复用 `GET /api/accounts` 再过滤**：那两个响应不是同一个东西。列表版每行带
 * `totalRemain` / `usedTotal` / `todayTokens`（要跑 `accountsWithSpend()`，会读凭据缓存和账本），
 * 而详情页要的是**带通道元数据的那一份**（`channelLabel` / `idPrefix` / 能力位）。
 * 让前端拿列表数据 + 三个子资源自己拼，等于把「详情页由哪些字段组成」这件事搬进前端，
 * 而它本来是服务端知识。
 *
 * **不发网络请求**：只读本地账号文件 + 通道自述。余额、用量、签到各有自己的端点，
 * 前端按需分别拉——把它们塞进这里会让每次刷新详情都打一遍上游。
 */
accountsRoutes.get('/api/accounts/:id', (c) => {
  const found = accountWithChannel(c.req.param('id'));
  if (!found) return c.json({ error: { message: `没有账号 ${c.req.param('id')}`, type: 'not_found' } }, 404);
  const { account, channel } = found;
  return c.json({
    account: {
      id: account.id,
      channelId: account.channelId,
      channelLabel: channel.label,
      idPrefix: channel.idPrefix,
      seq: account.seq,
      label: account.label,
      status: account.status,
      statusMessage: account.statusMessage,
      cooldownUntil: account.cooldownUntil,
      profile: account.profile,
      createdAt: account.createdAt,
      // 凭据的**存在性**，不是内容：token/密钥绝不能出现在任何 JSON 响应里。
      hasCredential: Boolean(account.credential),
      credentialSource: account.credential?.source ?? null,
      tokenExpiresAt: account.credential?.expiresAt ? new Date(account.credential.expiresAt).toISOString() : null,
    },
    channel: {
      id: channel.id,
      label: channel.label,
      idPrefix: channel.idPrefix,
      identity: channel.identity,
      multiAccount: channel.multiAccount !== false,
      ...capabilitiesOf(channel),
      reportsTokens: channel.reportsTokens !== false,
    },
  });
});

accountsRoutes.get('/api/accounts/:id/credits', async (c) => {
  const found = accountWithChannel(c.req.param('id'));
  if (!found) return c.json({ error: { message: `没有账号 ${c.req.param('id')}`, type: 'not_found' } }, 404);
  return c.json(await buildCredits(found.channel, found.account));
});

/**
 * 手动「刷新积分」：**绕过 30 秒缓存**，直接问上游。
 *
 * 为什么是 POST 而不是再来一个 GET：GET 的语义是「读我已有的」，这里是「让上游动一下」。
 * 而且浏览器和中间的代理会把 GET 缓存住，用过 POST 就不存在这个歧义。
 *
 * 账号级和通道级两个入口，返回体同构：`{ credits: { <账号 id>: {totalRemain, usedTotal,
 * limitTotal, prevRemain, prevAt, creditsAt, error} } }`。界面拿到后按 id 覆盖那几行就行，
 * 不用整页重拉——重拉会把「正在展开的更多菜单」等界面状态打断。
 */
function creditRows(reads: Record<string, { snapshot: { remain: number | null; used: number | null; limit: number | null; prevRemain: number | null; prevAt: number | null; at: number }; error: string | null }>) {
  const credits: Record<string, unknown> = {};
  for (const [id, read] of Object.entries(reads)) {
    credits[id] = {
      // 字段名和 `GET /api/accounts` 的每一行对齐，界面才能直接覆盖。
      totalRemain: read.snapshot.remain,
      usedTotal: read.snapshot.used,
      limitTotal: read.snapshot.limit,
      prevRemain: read.snapshot.prevRemain,
      prevAt: read.snapshot.prevAt,
      creditsAt: read.snapshot.at,
      error: read.error,
    };
  }
  return credits;
}

accountsRoutes.post('/api/accounts/:id/credits', async (c) => {
  const found = accountWithChannel(c.req.param('id'));
  if (!found) return c.json({ error: { message: `没有账号 ${c.req.param('id')}`, type: 'not_found' } }, 404);
  const reads = await refreshCredits([found.account]);
  return c.json({ credits: creditRows(reads) });
});

/** 通道级「刷新积分」：把这个通道下所有账号一起问一遍（并发，失败各自记错）。 */
accountsRoutes.post('/api/channels/:id/credits', async (c) => {
  const channel = channelById(c.req.param('id'));
  if (!channel) return c.json({ error: { message: `没有通道 ${c.req.param('id')}`, type: 'not_found' } }, 404);
  const accounts = accountsOf(channel.id);
  if (accounts.length === 0) return c.json({ credits: {} });
  const reads = await refreshCredits(accounts);
  return c.json({ credits: creditRows(reads) });
});

accountsRoutes.get('/api/accounts/:id/usage', async (c) => {
  const found = accountWithChannel(c.req.param('id'));
  if (!found) return c.json({ error: { message: `没有账号 ${c.req.param('id')}`, type: 'not_found' } }, 404);
  return c.json(await usageSummary({ account: found.account.id }));
});

/**
 * 输入框右边那个徽标要显示的东西：主数字 + 今日用量文案。
 *
 * 和 `/credits` 的区别：那个是**余额的完整快照**（套餐明细、账号信息、签到状态，
 * 给面板和账号页用），这个是**两个字符串**（给 14px 高的地方用）。分开是因为使用
 * 频率差一个量级——徽标每 60 秒轮询一次，面板打开才拉一次。
 *
 * `no-store`：余额是实时数字，缓存住会让「签完到 / 花完额度」看不出来。
 */
accountsRoutes.get('/api/accounts/:id/badge', async (c) => {
  const found = accountWithChannel(c.req.param('id'));
  if (!found) return c.json({ error: { message: `没有账号 ${c.req.param('id')}`, type: 'not_found' } }, 404);
  c.header('Cache-Control', 'no-store');
  return c.json(await buildBadge(found.channel, found.account));
});

accountsRoutes.get('/api/accounts/:id/checkin', async (c) => {
  const found = accountWithChannel(c.req.param('id'));
  if (!found) return c.json({ error: { message: `没有账号 ${c.req.param('id')}`, type: 'not_found' } }, 404);
  return c.json(await checkinEnvelope(found.account, found.channel));
});

accountsRoutes.post('/api/accounts/:id/checkin', async (c) => {
  const found = accountWithChannel(c.req.param('id'));
  if (!found) return c.json({ error: { message: `没有账号 ${c.req.param('id')}`, type: 'not_found' } }, 404);
  if (typeof found.channel.checkinClaimOf !== 'function') {
    return c.json({ error: { message: `${found.channel.label} 不支持签到`, type: 'bad_request' } }, 400);
  }
  let record;
  try {
    record = await found.channel.checkinClaimOf(found.account);
  } catch (error: any) {
    record = { date: '', status: 'error', message: error.message };
  }
  appendCheckinLog({
    ts: Date.now(),
    account: found.account.id,
    channel: found.channel.id,
    status: record.status,
    credits: typeof record.credits === 'number' ? record.credits : null,
    streakDays: typeof record.streakDays === 'number' ? record.streakDays : null,
    message: record.message ?? null,
    source: 'manual',
  });
  return c.json({ ok: record.status === 'checked' || record.status === 'already', result: record });
});

/**
 * 签到的响应信封。
 *
 * 形状沿用旧版按通道的签到接口：`today` / `last` / `status` 三段，改了要连消费方一起
 * 改（网关自己的账号页、`/api/accounts` 的调用方）。`today` 是本机日历日，`last` 是本地
 * 记录，`status` 是上游状态（通道没有状态接口时为 null）。查上游失败时 `error` 带原因，
 * `canClaim` 表示这个通道能不能手动领取。
 *
 * **`canClaim` 不看开关**：手动签到是允许的（用户点了就是显式意图），开关只管自动。
 * 界面拿 `checkinEnabled` 自己决定要不要提示「已关闭自动签到」。
 */
async function checkinEnvelope(account: Account, channel: any) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const last = channel.lastCheckinOf?.(account) ?? null;
  let status = null;
  let error: string | undefined;
  if (typeof channel.checkinStatusOf === 'function') {
    try {
      status = await channel.checkinStatusOf(account);
    } catch (err: any) {
      // 「暂时查不到」和「上游没这个接口」要分开：前者要显示错误，后者静默。
      error = err.message;
    }
  }
  return {
    ok: true,
    today,
    last,
    status,
    error,
    canClaim: typeof channel.checkinClaimOf === 'function',
    checkinEnabled: account.checkinEnabled,
  };
}
