import { Hono } from 'hono';

import type { AppEnv } from '../app.ts';
import type { ChatOutcome } from '../types.ts';
import { log } from '../logger.ts';
import { channels } from '../channels/index.ts';
import { accountsOf, applyFailure, checkUsable, markInvalid, markReady } from '../core/accounts.ts';
import { clearModelCooldown, markModelCooldown, modelCooldownOf } from '../core/model-cooldown.ts';
import { resolveModel, toExternalModel, unknownModelMessage } from '../core/router.ts';
import { recordChatUsage } from '../ledger.ts';
import { isCredentialError } from '../shared/credential-error.ts';
import { filterModels, isListed } from '../shared/model-visibility.ts';
import { formatClock } from '../shared/clock.ts';

export const openaiRoutes = new Hono<AppEnv>();

export async function modelListPayload(): Promise<{ object: 'list'; data: any[] }> {
  const tasks: { channel: (typeof channels)[number]; account: any }[] = [];
  for (const channel of channels) {
    if (!isListed(channel.idPrefix)) continue;
    for (const account of accountsOf(channel.id)) tasks.push({ channel, account });
  }

  const results = await Promise.all(
    tasks.map(async ({ channel, account }) => {
      try {
        return await channel.modelsOf(account);
      } catch (error: any) {
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

openaiRoutes.get('/models', async (c) => {
  return c.json(await modelListPayload());
});

openaiRoutes.post('/chat/completions', async (c) => {
  let body: any;
  try {
    body = JSON.parse(await c.req.text());
  } catch (error: any) {
    return c.json({ error: { message: `请求体不是合法 JSON：${error.message}`, type: 'gateway_error' } }, 400);
  }

  const route = resolveModel(body && body.model);
  if (!route) {
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

  const cooling = modelCooldownOf(account.id, modelId);
  if (cooling) {
    const when = formatClock(cooling.until);
    return c.json(
      {
        error: {
          message:
            `模型 ${modelId} 限流中，${when} 后可再用` +
            `（账号 ${account.id} 本身正常，换同账号的其他模型可以继续用）` +
            (cooling.message ? `：${cooling.message}` : ''),
          type: 'gateway_error',
          code: 'model_cooldown',
        },
      },
      429,
    );
  }

  body.model = modelId;

  const started = Date.now();
  const effort = typeof body.reasoning_effort === 'string' ? body.reasoning_effort : '(none)';

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
      markInvalid(account.id, message);
    } else if (status === 429) {
      markModelCooldown(account.id, modelId, retryAt ?? undefined, message);
      if (account.status === 'cooldown') markReady(account.id);
    } else {
      applyFailure(account, status, message, retryAt);
    }
    bookUsage(status);
    return c.json({ error: { message, type: 'gateway_error', code } }, status as any);
  }

  clearModelCooldown(account.id, modelId);

  if (outcome.kind === 'json') {
    settleLater(outcome.status);
    return c.json(outcome.body as any, outcome.status as any);
  }

  const iterator = outcome.body[Symbol.asyncIterator]();
  const encoder = new TextEncoder();

  let clientGone = false;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) {
          controller.close();
          settleLater(outcome.status);
          return;
        }
        controller.enqueue(encoder.encode(value));
      } catch (error: any) {
        if (clientGone) return;
        log(`chat stream error account=${account.id} model=${modelId}: ${error?.message || error}`);
        applyFailure(account, 502, error?.message || String(error));
        bookUsage(502);
        controller.error(error);
      }
    },
    async cancel() {
      clientGone = true;
      try {
        await iterator.return?.(undefined);
      } catch {
      }
      settleLater(499);
    },
  });

  return c.newResponse(stream as any, outcome.status as any, outcome.headers);
});
