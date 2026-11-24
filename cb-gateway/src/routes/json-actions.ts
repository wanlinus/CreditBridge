// v3 的 JSON 写端点：**服务端只剩这一套写入口了**。
//
// ## 为什么单独一个文件
//
// 这些端点横跨三个既有模块（账号 / 模型 / 签到）和两处配置（密码 / 签到时间），
// 塞进任何一个现有文件都会让那个文件多出一块与它主题无关的东西，而 routes/ 下的文件
// 是按**资源**分的。放在一起还能一眼看出「一共有哪些写入口」。
//
// ## 和表单版的关系
//
// **表单版已经全部删除**（2026-11-13，SPA 转正时）。这里每个端点都必须能被脚本独立
// 使用：路径和形状只描述数据，不描述「哪个页面在用它」，所以没有任何
// `back` / `redirect` / `notice` 这类页面概念。
//
// ## 一条硬规矩
//
// 写操作只能出现在 `/api/*` 下。页面层的 POST 一律不存在——那层现在是静态文件。

import { Hono } from 'hono';

import type { AppEnv } from '../app.ts';
import { channelById } from '../channels/index.ts';
import { getAccount, setAccountCheckinEnabled, updateAccount } from '../core/accounts.ts';
import { cancelLogin, cancelRunningLogins, getLoginTask } from '../core/login-tasks.ts';
import { checkinAllAccounts } from '../core/checkin-scheduler.ts';
import { config, isValidCheckinTime, updateConfig } from '../config.ts';
import { keySnapshotTtl, setKeySnapshotTtl } from '../core/keys.ts';
import {
  changePassword,
  clearCookie,
  createSession,
  destroySession,
  mustChangePassword,
  sessionCookie,
  sessionFromCookie,
  verifyPassword,
} from '../shared/gateway-auth.ts';
import { readJsonBody } from '../shared/json-body.ts';
import { invalidateCheckinSwitchCache } from '../shared/checkin-switch.ts';
import { log } from '../logger.ts';

export const jsonActionRoutes = new Hono<AppEnv>();

// ---------------------------------------------------------------- 登录 / 密码

/**
 * 登录（SPA 用）。
 *
 * 和 `POST /login`（表单版）**并存**：那条给不装 JS 的浏览器和 curl 用户，是 SPA 的 JS
 * 加载失败时唯一的后门。两条都调 `verifyPassword()` + `createSession()`，行为一致。
 *
 * 不区分「用户名错」和「密码错」——那会告诉攻击者「这个用户名存在」。
 */
jsonActionRoutes.post('/api/login', async (c) => {
  const parsed = await readJsonBody(c);
  if (!parsed.ok) return c.json({ error: { message: parsed.message, type: 'bad_request' } }, 400);
  const username = typeof parsed.body?.username === 'string' ? parsed.body.username : '';
  const password = typeof parsed.body?.password === 'string' ? parsed.body.password : '';
  if (!verifyPassword(username, password)) {
    log(`登录失败（JSON）：${username.slice(0, 32)}`);
    return c.json({ error: { message: '用户名或密码不对', type: 'unauthorized' } }, 401);
  }
  const sid = createSession();
  log(`登录成功（JSON）：${username}`);
  return new Response(JSON.stringify({ ok: true, mustChangePassword: mustChangePassword() }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': sessionCookie(sid),
      'Cache-Control': 'no-store',
    },
  });
});

/**
 * 退出登录。
 *
 * 旧版是一条 `GET /logout` 的表单动作（302 回登录页）。SPA 里没有「页面动作」这一层了，
 * 所以改成 `POST /api/logout`：销毁会话、清 Cookie、回 JSON，由前端自己路由到 `/login`。
 *
 * **幂等**：没有会话时也回 200。用户点「退出」时正确的反馈永远是「已退出」，
 * 而不是让他去分辨「这次是退成功了还是本来就没登录」。
 *
 * 它在 `PUBLIC_PATHS` 里——不被 authGate 拦，理由和 `/api/login` 一样。
 */
jsonActionRoutes.post('/api/logout', (c) => {
  const sid = sessionFromCookie(c.req.header('cookie'));
  const removed = sid ? destroySession(sid) : false;
  if (removed) log('会话已退出（JSON）');
  return new Response(JSON.stringify({ ok: true, removed }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': clearCookie(),
      'Cache-Control': 'no-store',
    },
  });
});

/**
 * 改密。强制改密和常规改密是**同一条**——`passwordGate` 只管「改了没」，不管「改了什么」。
 *
 * 返回 `{ok:true}`；失败给 400 + 服务端原文（`changePassword()` 已经返回人话）。
 * **改密不换 key**：`api_key` 表和密码是两套独立凭据。
 */
jsonActionRoutes.post('/api/password', async (c) => {
  const parsed = await readJsonBody(c);
  if (!parsed.ok) return c.json({ error: { message: parsed.message, type: 'bad_request' } }, 400);
  const current = typeof parsed.body?.current === 'string' ? parsed.body.current : '';
  const next = typeof parsed.body?.next === 'string' ? parsed.body.next : '';
  const confirm = typeof parsed.body?.confirm === 'string' ? parsed.body.confirm : '';
  if (next !== confirm) {
    return c.json({ error: { message: '两次输入的新密码不一致', type: 'bad_request' } }, 400);
  }
  const problem = changePassword(current, next);
  if (problem) return c.json({ error: { message: problem, type: 'bad_request' } }, 400);
  log('网关密码已更新（JSON）');
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- 配置

/**
 * 改配置：`checkinTime`（写入 config.json）+ `keysSnapshotTtlMs`（运行时，不落盘）。
 *
 * 两个字段的存储位置不同，原因是生命周期不同：
 *   - `checkinTime` 是「部署时定好的策略」，进 `config.json` 供运维手改
 *   - `keysSnapshotTtlMs` 是「调优参数」，只在内存里。重启回默认值不影响正确性
 *     （最坏是多跑几次 scrypt），没必要为它占一个持久化字段
 *
 * `updateConfig()` 内部有白名单，未知键会被拒——所以这里不用自己再写一遍校验。
 */
jsonActionRoutes.patch('/api/config', async (c) => {
  const parsed = await readJsonBody(c);
  if (!parsed.ok) return c.json({ error: { message: parsed.message, type: 'bad_request' } }, 400);

  const patch: Record<string, unknown> = {};
  if (parsed.body?.checkinTime !== undefined) {
    if (!isValidCheckinTime(parsed.body.checkinTime)) {
      return c.json({ error: { message: '签到时间必须是 HH:MM（24 小时制）', type: 'bad_request' } }, 400);
    }
    patch.checkinTime = parsed.body.checkinTime;
  }
  if (parsed.body?.keysSnapshotTtlMs !== undefined) {
    const ttl = Number(parsed.body.keysSnapshotTtlMs);
    // 下限 1 分钟：再短就是在拿 scrypt 换「更及时」，没有意义。
    // 上限 30 天：给个边界，防止手抖填成 1e15 把 TTL 变成永久。
    if (!Number.isFinite(ttl) || ttl < 60_000 || ttl > 30 * 24 * 60 * 60 * 1000) {
      return c.json(
        { error: { message: 'API key 快照 TTL 必须在 1 分钟到 30 天之间（毫秒）', type: 'bad_request' } },
        400,
      );
    }
  }

  if (Object.keys(patch).length === 0 && parsed.body?.keysSnapshotTtlMs === undefined) {
    return c.json(
      { error: { message: '没有可改的字段（支持 checkinTime、keysSnapshotTtlMs）', type: 'bad_request' } },
      400,
    );
  }

  // 先改文件配置，成功后改运行时参数——反过来的话文件写失败会让两者不一致。
  if (Object.keys(patch).length > 0) {
    const result = updateConfig(patch);
    if (!result.ok) return c.json({ error: { message: result.error || '更新失败', type: 'bad_request' } }, 400);
  }

  if (parsed.body?.keysSnapshotTtlMs !== undefined) {
    setKeySnapshotTtl(Number(parsed.body.keysSnapshotTtlMs));
  }

  return c.json({ ok: true, checkinTime: config.checkinTime, keysSnapshotTtlMs: keySnapshotTtl() });
});

// ---------------------------------------------------------------- 签到

/**
 * 一键签到所有 `ready` 账号。
 *
 * 和表单版（`POST /checkin/all`）**不重试**、也**不跳过今天已签的**——那两条都是
 * 「用户手动点了，要立刻看到每个号现在的状态」。自动调度那一套（含重试阶梯）在
 * `core/checkin-scheduler.ts` 的 `runOnce()`，和这里不是一回事。
 */
jsonActionRoutes.post('/api/checkin/all', async (c) => {
  const results = await checkinAllAccounts();
  const okCount = results.filter((r) => r.status === 'checked' || r.status === 'already').length;
  return c.json({
    results,
    okCount,
    failCount: results.length - okCount,
  });
});

// ---------------------------------------------------------------- 签到开关

/**
 * 账号级签到开关。关掉后不再自动签，手动点仍然可以签。
 *
 * 落库走 `core/accounts.ts` 的 `setAccountCheckinEnabled()`：那边有内存副本，
 * 只写 `store/` 的话 `/api/accounts` 会读到旧对象。
 */
jsonActionRoutes.patch('/api/accounts/:id/checkin-switch', async (c) => {
  const account = getAccount(c.req.param('id'));
  if (!account) return c.json({ error: { message: `没有账号 ${c.req.param('id')}`, type: 'not_found' } }, 404);
  const channel = channelById(account.channelId);
  if (!channel || typeof channel.checkinClaimOf !== 'function') {
    return c.json({ error: { message: '这个通道不支持签到', type: 'bad_request' } }, 400);
  }
  const parsed = await readJsonBody(c);
  if (!parsed.ok) return c.json({ error: { message: parsed.message, type: 'bad_request' } }, 400);
  const enabled = parsed.body?.enabled;
  if (typeof enabled !== 'boolean') {
    return c.json({ error: { message: 'enabled 必须是布尔值', type: 'bad_request' } }, 400);
  }
  const updated = setAccountCheckinEnabled(account.id, enabled);
  if (!updated) return c.json({ error: { message: `没有账号 ${account.id}`, type: 'not_found' } }, 404);
  invalidateCheckinSwitchCache();
  log(`checkin 账号 ${account.id} 开关 -> ${enabled ? '开' : '关'}`);
  return c.json({ ok: true, account: account.id, checkinEnabled: enabled });
});

// ---------------------------------------------------------------- 登录任务动作

/**
 * 取消某个登录任务。**幂等**：任务已经结束（或压根不存在）也回 200——
 * 用户连点两下不该看到报错。
 */
jsonActionRoutes.delete('/api/accounts/:channel/login/:taskId', (c) => {
  const channel = channelById(c.req.param('channel'));
  if (!channel) return c.json({ error: { message: `没有通道 ${c.req.param('channel')}`, type: 'not_found' } }, 404);
  const taskId = c.req.param('taskId');
  // 先确认存在性再取消，好让「任务是别人的」这种情况不会静默成功；已结束的任务照样 200。
  const task = getLoginTask(channel.id, taskId);
  const cancelled = cancelLogin(channel.id, taskId);
  return c.json({ ok: true, cancelled, existed: Boolean(task) });
});

/** 取消这个通道正在跑的登录（不管 taskId）。同样是幂等的。 */
jsonActionRoutes.delete('/api/accounts/:channel/login', (c) => {
  const channel = channelById(c.req.param('channel'));
  if (!channel) return c.json({ error: { message: `没有通道 ${c.req.param('channel')}`, type: 'not_found' } }, 404);
  const count = cancelRunningLogins(channel.id);
  return c.json({ ok: true, cancelled: count });
});

// ---------------------------------------------------------------- 账号动作

/** 上游退出（只注销会话，**不删账号文件**）。通道没有 `logoutOf` 时是什么都不做的成功。 */
jsonActionRoutes.post('/api/accounts/:id/logout', async (c) => {
  const account = getAccount(c.req.param('id'));
  if (!account) return c.json({ error: { message: `没有账号 ${c.req.param('id')}`, type: 'not_found' } }, 404);
  const channel = channelById(account.channelId);
  let upstream: string | null = null;
  if (channel && typeof channel.logoutOf === 'function') {
    try {
      await channel.logoutOf(account);
    } catch (error: any) {
      // 上游退出失败不等于本地账号坏了：令牌到期自然失效。记日志，照常回成功。
      upstream = error.message;
      log(`${account.id} 上游退出失败：${error.message}`);
    }
  }
  return c.json({ ok: true, upstream, removed: false });
});

/**
 * 换设备号。
 *
 * `changed` 区分「真的换了」和「这个通道不支持」——界面据此决定提示什么。
 * **合并**进凭据而不是整份替换：整份替换会把 token 和密钥对抹掉，账号直接废掉。
 */
jsonActionRoutes.post('/api/accounts/:id/rotate-device', (c) => {
  const account = getAccount(c.req.param('id'));
  if (!account) return c.json({ error: { message: `没有账号 ${c.req.param('id')}`, type: 'not_found' } }, 404);
  const channel = channelById(account.channelId);
  if (!channel || typeof channel.rotateDeviceIdOf !== 'function') {
    return c.json({ ok: true, changed: false, reason: '这个通道不支持换设备号' });
  }
  const patch = channel.rotateDeviceIdOf(account);
  if (!patch) return c.json({ ok: true, changed: false, reason: '没有需要换的字段' });
  updateAccount(account.id, { credential: { ...(account.credential || {}), ...patch } });
  log(`${account.id} 设备号已更换（JSON）：${JSON.stringify(patch)}`);
  return c.json({ ok: true, changed: true, fields: Object.keys(patch) });
});

// 说明：下面这些端点**已经在既有文件里**，这里不再重复注册（Hono 同路径同方法会冲突）：
//
//   POST   /api/accounts/:channel/login            → routes/accounts.ts（本来就是 JSON）
//   POST   /api/accounts/:channel/login/:taskId/answer → routes/accounts.ts（已改造为表单+JSON 双支持）
//   PATCH  /api/accounts/:id                       → routes/accounts.ts
//   DELETE /api/accounts/:id                       → routes/accounts.ts
//   POST   /api/accounts/:id/verify                → routes/accounts.ts
//   POST   /api/accounts/:id/checkin               → routes/accounts.ts
//   POST   /api/keys · PATCH/DELETE /api/keys/:id  → routes/keys.ts
//   POST   /api/models/visibility                  → routes/admin.ts（已改造为表单+JSON 双支持）

