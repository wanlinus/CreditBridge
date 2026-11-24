// OpenAI 兼容入口。v2 只有这两条路由对外，DSH 只认它们。模型 id 是 `<idPrefix>-<seq>/<上游模型>`（`wb-1/hy4free`），
// 拆解和显示名在 `core/router.ts`。**没有通道前缀路由了**：通道只作为模型 id 的前半段存在。

import { Hono } from 'hono';

import type { AppEnv } from '../app.ts';
import type { ChatOutcome } from '../types.ts';
import { log } from '../logger.ts';
import { channels } from '../channels/index.ts';
import { accountsOf, applyFailure, checkUsable, markInvalid, markReady } from '../core/accounts.ts';
import { resolveModel, toExternalModel, unknownModelMessage } from '../core/router.ts';
import { recordChatUsage } from '../ledger.ts';
import { isCredentialError } from '../shared/credential-error.ts';
import { filterModels, isListed } from '../shared/model-visibility.ts';
import { defaultEffortFor } from '../shared/model-settings.ts';
import { readJsonBody } from '../shared/json-body.ts';

export const openaiRoutes = new Hono<AppEnv>();

// 模型列表的内容，**`/v1/models` 和 `/api/models` 共用这一份**：两者拿到的必须逐字节相同，否则
// 「探测到 17 个、实际能选 16 个」这种事迟早发生。按账号展开而不是合并——指定账号就是「用这个号的额度」。
// 账号失效时模型**不消失**（只改 `accountStatus`）：列表已被 DSH 固化进 profile，网关删了也不会同步过去。
// **每个账号并发取**：插件每 15 秒轮询一次，串行会让 N 个账号 N 倍等待，而插件有超时，
// 账号一多就超时返回空列表，表现成「模型全没了」，过一轮又回来。
export async function modelListPayload(): Promise<{ object: 'list'; data: any[] }> {
  // 先按通道 + 账号摊平成一张任务表，再一次性并发，最后按原顺序拼回去（顺序是用户看到的顺序）。
  const tasks: { channel: (typeof channels)[number]; account: any }[] = [];
  for (const channel of channels) {
    // 可见性按 `idPrefix` 记，不含账号——隐藏一个模型时不该对每个号各勾一次。
    if (!isListed(channel.idPrefix)) continue;
    for (const account of accountsOf(channel.id)) tasks.push({ channel, account });
  }

  const results = await Promise.all(
    tasks.map(async ({ channel, account }) => {
      try {
        return await channel.modelsOf(account);
      } catch (error: any) {
        // 未登录 / 凭据坏掉 / 上游接口暂时不通，都会在这里失败。跳过这个账号，别让整个列表跟着 500。
        log(`[models] ${account.id} 取不到，跳过：${error.message}`);
        return null;
      }
    }),
  );

  const data: any[] = [];
  for (let i = 0; i < tasks.length; i += 1) {
    const models = results[i];
    if (!models) continue;
    const { channel, account } = tasks[i];
    for (const model of filterModels(channel.idPrefix, models)) {
      data.push(toExternalModel(channel, account, model));
    }
  }
  return { object: 'list', data };
}

/** `GET /v1/models`：OpenAI 兼容入口。 */
openaiRoutes.get('/models', async (c) => {
  return c.json(await modelListPayload());
});

// 对话入口。链路：解析 id（拆不出 404）→ 判账号状态（cooldown 429 / invalid 503 / disabled 503）→
// 通道转发 → 记账（`provider` + `account` + `model` 三段身份）→ 失败时按上游状态码改账号状态；
// **不换号**——指定的语义就是「这个号」。
openaiRoutes.post('/chat/completions', async (c) => {
  const parsed = await readJsonBody(c);
  if (!parsed.ok) {
    // `/v1/*` 是 OpenAI 协议入口，`type` 保持 `gateway_error`（DSH 看到不认识的 type 会当成未知错误）。
    return c.json({ error: { message: parsed.message, type: 'gateway_error' } }, 400);
  }
  const body = parsed.body;

  const route = resolveModel(body && body.model);
  if (!route) {
    // 不猜通道、也不跨账号兜底：拆不出就 404，写清楚正确形状。
    return c.json(
      { error: { message: unknownModelMessage(body && body.model), type: 'gateway_error', code: 'model_not_found' } },
      404,
    );
  }

  const { channel, account, modelId } = route;

  const gate = checkUsable(account);
  if (!gate.ok) {
    return c.json(
      { error: { message: gate.message, type: 'gateway_error', code: gate.code } },
      gate.code === 'account_cooldown' ? 429 : 503,
    );
  }

  // 上游只认裸 id：账号段和通道前缀是网关自己的寻址方式。
  body.model = modelId;

  // **缺省思考档在这里落地**，只在**缺席**时补、不覆盖客户端显式发来的值：DSH 的思考强度选择器是
  // 它的原生 UI，网关硬盖会让那个控件变成摆设。DSH 选 `off` 时发字符串 `"off"`，选「跟随默认」时
  // 一个字段都不发，所以两者能分开。
  const effortBeforeInject = typeof body.reasoning_effort === 'string' ? body.reasoning_effort : null;
  if (effortBeforeInject === null) {
    const fallback = defaultEffortFor(channel.idPrefix, modelId);
    if (fallback) {
      body.reasoning_effort = fallback;
      log(`effort: ${account.id}/${modelId} 未指定思考档，按网关设置补 ${fallback}`);
    }
  }

  const started = Date.now();
  const effort = typeof body.reasoning_effort === 'string' ? body.reasoning_effort : '(none)';

  // 通道拿到用量时把它塞进来。**「响应结束」不等于「用量已就绪」**：客户端中途断流、上游卡住时
  // 通道可能一直不回调 `onUsage`。20 秒超时是「用量迟迟不来时也要把这一行记上」的兜底——
  // 账本里宁可有一行 token 为空，也不该整条请求消失。
  let usage: any = null;
  let notifyUsage: ((value: any) => void) | null = null;
  const usageReady = new Promise<any>((resolve) => {
    notifyUsage = resolve;
  });
  const onUsage = (next: any) => {
    usage = next;
    notifyUsage?.(next);
    notifyUsage = null;
  };

  /** 等用量就绪（最多 20 秒）后记一行账。重复调用安全。 */
  let settled = false;
  const bookUsage = (status: number) => {
    if (settled) return;
    settled = true;
    recordChatUsage(usage, modelId, effort, started, status, channel.id, account.id);
  };
  const settleLater = (status: number) => {
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 20_000).unref?.());
    void Promise.race([usageReady, timeout]).then(() => bookUsage(status));
  };

  let outcome: ChatOutcome;
  try {
    outcome = await channel.chatAs(account, {
      body,
      // 客户端断开时把上游也掐掉，否则网关还在往没人收的流里读，白烧额度。
      signal: c.req.raw.signal,
      onUsage,
    });
  } catch (error: any) {
    const status = typeof error?.status === 'number' ? error.status : 502;
    const code = typeof error?.code === 'string' ? error.code : 'gateway_error';
    const message = error?.message || String(error);
    log(`chat failed account=${account.id} model=${modelId} status=${status}: ${message.slice(0, 300)}`);
    const retryAt = typeof error?.retryAt === 'number' ? error.retryAt : null;
    if (isCredentialError(error) && error.permanent) {
      // **这个号再也刷不出凭据了**，必须标 `invalid`。早先这类错误一律走 502、不改账号状态，
      // 于是账号永远显示「就绪」，用户看到「模型都在列表里，点哪个都报错」而管理台毫无提示。
      // 只认 `permanent`：网络抖动、上游 5xx 也是 502，那种不该把号封成失效。
      markInvalid(account.id, message);
    } else if (status === 429) {
      // **429 只让账号保持可用，不记任何模型级状态。** 上游限流是按模型的，但「什么时候恢复」
      // 网关不知道：WorkBuddy 不发 `Retry-After`，真实时间只写在中文 `msg` 里。2026-11-10 曾为此
      // 加过 `core/model-cooldown.ts`（落盘记 5 分钟兜底），2026-11-13 删了——那个 5 分钟是猜的，
      // 而且它在转发**之前**直接 429（上游其实已恢复也照样拒），「成功就清冷却」永远不可达。
      // 现在如实把上游的 429 原样回给客户端，由客户端自己退避。
      if (account.status === 'cooldown') markReady(account.id);
    } else {
      applyFailure(account, status, message, retryAt);
    }
    // 失败当场记：用量要么没有、要么就是已经进了这个回调。
    bookUsage(status);
    return c.json({ error: { message, type: 'gateway_error', code } }, status as any);
  }

  if (outcome.kind === 'json') {
    // 先把响应发出去，记账在后台等用量。
    settleLater(outcome.status);
    return c.json(outcome.body as any, outcome.status as any);
  }

  // 流式：把通道的 async generator 包成 Web 流。
  //
  // 不用 `hono/streaming` 的 `stream()`：它会把 content-type 改成 text/plain，而 SSE 的头是通道自己定的。
  // 也不用 `for await` 一把梭：那样客户端断开时没人调 `iterator.return()`，上游的读循环会一直跑到自己结束。
  const iterator = outcome.body[Symbol.asyncIterator]();
  const encoder = new TextEncoder();

  // 客户端是否已经主动断开。`cancel()` 会置位，`pull()` 里的异常据此区分「上游真的挂了（502）」
  // 和「我们自己取消导致的异常（499）」。没有这个标志时：客户端一断，正在 `await iterator.next()`
  // 的 pull 就抛错，那一支 `bookUsage(502)` 会抢在 `cancel()` 前面把这一行记成失败、用量记成 null。
  // 2026-11-10 的「今日用量恒为 0」就是这条路径——账本里 516 行 499 全带 null。
  let clientGone = false;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) {
          // 先关流（客户端立刻收到 [DONE]），再去等用量记账。
          controller.close();
          settleLater(outcome.status);
          return;
        }
        controller.enqueue(encoder.encode(value));
      } catch (error: any) {
        // 取消引发的异常交给 `cancel()` 记账，别在这里记成 502。
        if (clientGone) return;
        log(`chat stream error account=${account.id} model=${modelId}: ${error?.message || error}`);
        // 头已经发出去了，改不了状态码；只能断流 + 记一笔失败。
        applyFailure(account, 502, error?.message || String(error));
        bookUsage(502);
        controller.error(error);
      }
    },
    async cancel() {
      // 客户端主动断开（用户点停止、关掉对话、切模型）。**顺序很重要**：先让 iterator 收尾，再记账。
      // 早先是先 `bookUsage(499)` 再 `iterator.return()`，于是账本拿到的永远是 `usage = null`——
      // 上游的 usage 帧在流尾，那一刻还没读到，结果「今日用量永远是 0」（2026-11-10 用户报的）。
      // `return()` 让通道生成器走 `finally` 里的 `onUsage(usage)`；但客户端断开时 `c.req.raw.signal`
      // 会把上游 fetch 一起掐掉，那样 usage 帧确实读不到，记 null 是诚实的：我们不知道花了多少。
      clientGone = true;
      try {
        await iterator.return?.(undefined);
      } catch {
        /* 已经结束了 */
      }
      settleLater(499);
    },
  });

  return c.newResponse(stream as any, outcome.status as any, outcome.headers);
});
