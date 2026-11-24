// 网关自有端点。**全部在 `/api/*` 下**：`/v1/*` 是 OpenAI 兼容入口，网关自己的东西不该混进去。
// 2026-11-22 曾按主题拆成 4 个文件又合回来（拆完 `usage.ts` 只剩 35 行代码、`admin.ts` 只剩 11 行组合器）；
// `events.ts` 仍单独一个文件，因为 SSE 那段是整个 admin 里逻辑最重的一块。

import { Hono } from 'hono';

import type { AppEnv } from '../app.ts';
import { log } from '../logger.ts';
import { config } from '../config.ts';
import { channels, channelByPrefix, channelById } from '../channels/index.ts';
import { accountsOf, getAccount } from '../core/accounts.ts';
import { capabilitiesOf, primaryAccountOf } from '../core/channel-info.ts';
import { versionSourceOf } from '../core/channel-versions.ts';
import { lastFetchedAt } from '../store/versions.ts';
import { iconOf, letterOf } from '../core/channel-icons.ts';
import { keySnapshotTtl } from '../core/keys.ts';
import { readCheckinLog } from '../core/checkin-log.ts';
import { modelListPayload } from './openai.ts';
import { usageHourly, usageSummary } from '../ledger.ts';
import {
  MIN_CONTEXT,
  MAX_CONTEXT,
  MIN_OUTPUT,
  allSettings,
  assertNumber,
  contextOptions,
  effectiveEffort,
  effortsOf,
  maxContextOf,
  settingKey,
  writeSetting,
} from '../shared/model-settings.ts';
import { PACKAGE_VERSION, STARTED_AT_ISO } from '../shared/build-info.ts';
import { isListed, setListed, setVisibleFor, visibleFor, visibleModels } from '../shared/model-visibility.ts';
import { requestShutdown } from '../lifecycle.ts';
import { readJsonBody } from '../shared/json-body.ts';
import { eventsRoutes } from './events.ts';

export const adminRoutes = new Hono<AppEnv>();

// events 单独一个文件，挂回同一条根路径。
adminRoutes.route('/', eventsRoutes);

// ---------------------------------------------------------------- 网关自述与生命周期

// 健康快照。**在 `/api/` 下、要认证**，不是无认证探针（容器 healthcheck 探的是 `/login`）。
// **只报本地状态、不发网络请求**：它被反复轮询，每次打上游等于把限流额度花在读健康上；验活用 `POST /api/accounts/<id>/verify`。
adminRoutes.get('/api/health', (c) => {
  const accounts = channels.flatMap((channel) =>
    accountsOf(channel.id).map((account) => ({
      id: account.id,
      channelId: channel.id,
      channelLabel: channel.label,
      idPrefix: channel.idPrefix,
      label: account.label,
      status: account.status,
      statusMessage: account.statusMessage,
      cooldownUntil: account.cooldownUntil,
      uid: account.profile?.uid ?? null,
      username: account.profile?.username ?? null,
      hasCredential: Boolean(account.credential),
      createdAt: account.createdAt,
    })),
  );

  const info: Record<string, any> = {};
  for (const channel of channels) {
    // `identity` 一起回，是为了排查「上游说客户端太旧」——版本号按通道声明，不看这里只能进容器翻源码。
    // `listed` 是模型列表总闸：同步模型清单的人必须能区分「这个通道关掉了」（要写空 `models:` 段）
    // 和「这个账号没登录、翻出 0 个模型」（必须跳过）。
    info[channel.id] = {
      id: channel.id,
      label: channel.label,
      idPrefix: channel.idPrefix,
      identity: channel.identity,
      // 版本号是哪来的：`auto` 刚拉的 / `cached` 库里的旧值 / `default` 代码写死的。
      // 排查「上游说客户端太旧」时先看这个——`default` 说明这个通道还没实现 `fetchIdentity`。
      versionSource: versionSourceOf(channel.id),
      versionFetchedAt: lastFetchedAt(channel.id),
      listed: isListed(channel.idPrefix),
      multiAccount: channel.multiAccount !== false,
      // 能力位和 `GET /api/accounts` 的 `channels[]` **同源**（`core/channel-info.ts`）：
      // 两处各抄一遍 `typeof` 的话，加第五个能力位时漏一处就是「那个按钮永远不显示」。
      ...capabilitiesOf(channel),
      accounts: accounts.filter((account) => account.channelId === channel.id).map((account) => account.id),
    };
  }

  return c.json({
    ok: true,
    gateway: 'up',
    version: PACKAGE_VERSION,
    startedAt: STARTED_AT_ISO,
    // 每天签到的时间点（`HH:MM`，容器时区）。放这里而不是新开 `/api/settings`：零成本本地读，不违反上面那条。
    checkinTime: config.checkinTime,
    // API key 校验快照的 TTL。同理：都是「网关运行时的可调参数」，零成本本地读。
    keysSnapshotTtlMs: keySnapshotTtl(),
    // 模型 id 的形状写在这里：插件/脚本要拼模型列表时读它，别自己硬编码格式。
    modelIdFormat: '<idPrefix>-<seq>/<model>',
    channels: info,
    accounts,
  });
});

/** 通道的**外观**清单：名字 + 图标。和 `/health` 分开是因为缓存策略完全相反——这个能缓存 5 分钟，`/health` 一秒都不能。`letter` 是图标缺失时的兜底，由网关给，前端不用猜「取哪个字段的第一个字」。 */
adminRoutes.get('/api/channels', (c) => {
  c.header('Cache-Control', 'private, max-age=300');
  return c.json({
    channels: channels.map((channel) => ({
      id: channel.id,
      label: channel.label,
      idPrefix: channel.idPrefix,
      letter: letterOf(channel),
      icon: iconOf(channel.id),
    })),
  });
});

adminRoutes.post('/api/shutdown', (c) => {
  requestShutdown();
  return c.json({ ok: true, stopping: true });
});

// ---------------------------------------------------------------- 模型目录 / 设置 / 可见性

/** 模型列表的语义化路径，和 `/v1/models` **逐字节相同**（共用 `modelListPayload()`），否则会出现「探测到 17 个、实际能选 16 个」。 */
adminRoutes.get('/api/models', async (c) => {
  return c.json(await modelListPayload());
});

// 上游模型**目录**（不是可见性、不是 `/v1/models`）。两种问法返回的东西**不一样，别互换**：
//   不带参数（通道级）取**第一个 `ready` 账号**的目录，这是 `/models` 页的口径；
//   `?account=<id>`（账号级）取**那个账号自己**的全量目录，用途是核对「这个号实际有什么」。
// 多账号时两者可能不同（会员等级、灰度批次）。**拿通道级结果渲染账号级页面**会把「这个号有什么」
// 显示成「它兄弟号有什么」，而那一页存在的意义恰恰是核对上游。
// **不加服务端缓存**：上游目录本来就有通道级缓存，再加一层会让「点刷新没变化」。失败的通道不整体报错，该块带 `error` 降级。
adminRoutes.get('/api/models/catalog', async (c) => {
  const accountId = new URL(c.req.url).searchParams.get('account');

  if (accountId) {
    const account = getAccount(accountId);
    const channel = account ? channelById(account.channelId) : undefined;
    if (!account || !channel) {
      return c.json({ error: { message: `没有账号 ${accountId}`, type: 'not_found' } }, 404);
    }
    let models: any[] = [];
    let error: string | null = null;
    try {
      models = await channel.modelsOf(account);
    } catch (err: any) {
      error = err?.message || String(err);
    }
    return c.json({
      account: account.id,
      channelId: channel.id,
      idPrefix: channel.idPrefix,
      label: channel.label,
      models,
      error,
      visible: visibleFor(channel.idPrefix),
      listed: isListed(channel.idPrefix),
    });
  }

  const settings = allSettings();
  const groups = [];
  for (const channel of channels) {
    // 「优先 ready，没有就第一个，一个都没有就 null」——和 `POST /api/models/settings` 的档位校验共用
    // `primaryAccountOf`。两处各写一遍的表现是「目录页能列出模型、设置页存不进去」这种只有一半坏掉的状态。
    const source = primaryAccountOf(channel.id);
    let models: any[] = [];
    let error: string | null = null;
    if (source) {
      try {
        models = await channel.modelsOf(source);
      } catch (err: any) {
        error = err?.message || String(err);
      }
    }

    // 上下文窗口的**可选档位**只有实现了 `catalogOf` 的通道有：那是上游客户端选择器的数据，即 provider 真正接受的尺寸。
    const lengths: Record<string, any> = {};
    if (source && typeof channel.catalogOf === 'function') {
      try {
        for (const model of await channel.catalogOf(source)) {
          if (model.lengths) lengths[model.id] = model.lengths;
        }
      } catch (err: any) {
        log(`models/catalog: ${channel.id} 的档位表取不到（${err.message}）`);
      }
    }
    const lengthsOf = (modelId: string) => lengths[modelId] ?? null;

    groups.push({
      channelId: channel.id,
      idPrefix: channel.idPrefix,
      label: channel.label,
      source: source ? source.id : null,
      models: models.map((model) => {
        const setting = settings[settingKey(channel.idPrefix, model.id)] ?? {};
        const declared = lengthsOf(model.id);
        const effectiveContextWindow = maxContextOf(declared, model.context_length);
        // **上下文窗口永远是下拉**：上游给了档位就用它的，没给就按上限推三档。不改成自由填数字——
        // 那会让「这个值到底是不是上游认的」变成一个没人能回答的问题。
        const lengths =
          declared && Array.isArray(declared.options) && declared.options.length > 0
            ? declared
            : { default: effectiveContextWindow, options: contextOptions(effectiveContextWindow) };
        return {
          ...model,
          // 可选思考档位（`off` 已归一到 DSH 的叫法）。空数组 = 这个模型不能思考。
          efforts: effortsOf(model),
          // 当前生效的缺省思考档；没配过就是档位表里最高那一档。
          effectiveEffort: effectiveEffort(channel.idPrefix, model),
          // 当前生效的缺省上下文窗口 = **这个模型允许的最大尺寸**，不是 `lengths.default`（那是选择器默认档，可能小于上限）。
          effectiveContextWindow,
          // 用户在网关配过的值（null = 跟随默认）
          setting: {
            contextWindow: setting.contextWindow ?? null,
            maxOutputTokens: setting.maxTokens ?? null,
            reasoningEffort: setting.reasoningEffort ?? null,
          },
          lengths,
        };
      }),
      error,
      visible: visibleFor(channel.idPrefix),
      listed: isListed(channel.idPrefix),
      multiAccount: channel.multiAccount !== false,
    });
  }
  return c.json({ channels: groups });
});

// 写一个模型的设置。形状：`{ prefix, modelId, contextWindow?, maxOutputTokens?, reasoningEffort? }`，
// 字段传 `null` / `""` = 恢复默认。设置只存在网关这一份（`model_setting` 表），插件退化成「照抄 `/api/models`」——
// 早先网关和插件两头各存一份，容器部署下网关那条路径根本不存在，等于死代码。
// 校验放在这里而不是页面：这里是唯一能拒绝非法值的地方。**配错档位不会报错，只会让上游静默按默认跑**。
adminRoutes.post('/api/models/settings', async (c) => {
  const parsed = await readJsonBody(c);
  if (!parsed.ok) return c.json({ error: { message: parsed.message, type: 'bad_request' } }, 400);
  const body = parsed.body;

  const prefix = typeof body.prefix === 'string' ? body.prefix.trim() : '';
  const modelId = typeof body.modelId === 'string' ? body.modelId.trim() : '';
  const channel = channelByPrefix(prefix);
  if (!channel) {
    return c.json({ error: { message: `没有短前缀为 "${prefix}" 的通道`, type: 'bad_request' } }, 400);
  }
  if (!modelId) {
    return c.json({ error: { message: 'modelId 不能为空', type: 'bad_request' } }, 400);
  }

  const patch: any = {};
  try {
    if ('contextWindow' in body) {
      patch.contextWindow =
        body.contextWindow === null
          ? null
          : assertNumber(modelId, 'contextWindow', body.contextWindow, MIN_CONTEXT, MAX_CONTEXT);
    }
    if ('maxOutputTokens' in body) {
      patch.maxTokens =
        body.maxOutputTokens === null
          ? null
          : assertNumber(modelId, 'maxOutputTokens', body.maxOutputTokens, MIN_OUTPUT, MAX_CONTEXT);
    }
    if ('reasoningEffort' in body) {
      const value = body.reasoningEffort;
      if (value === null || value === '') {
        patch.reasoningEffort = null;
      } else if (typeof value !== 'string') {
        throw new Error('reasoningEffort 要是字符串');
      } else {
        // 档位必须在这个模型报的档位表里。取不到目录时**放行**（网络问题不该让人连改都改不了），
        // 但记一条日志——静默接受一个上游不认的档位是更坏的结果。
        const source = primaryAccountOf(channel.id);
        let efforts: string[] | null = null;
        if (source) {
          try {
            const models = await channel.modelsOf(source);
            const hit = models.find((model) => model.id === modelId);
            if (hit) efforts = effortsOf(hit);
          } catch {
            efforts = null;
          }
        }
        if (efforts && !efforts.includes(value)) {
          throw new Error(`${modelId} 不支持思考档 "${value}"（可选：${efforts.join(' / ')}）`);
        }
        if (!efforts) log(`model-settings: ${modelId} 的档位表取不到，跳过档位校验`);
        patch.reasoningEffort = value;
      }
    }
  } catch (error: any) {
    return c.json({ error: { message: error.message, type: 'bad_request' } }, 400);
  }

  const saved = writeSetting(prefix, modelId, patch);
  log(`model-settings: ${settingKey(prefix, modelId)} → ${JSON.stringify(saved)}`);
  return c.json({ ok: true, setting: saved });
});

/** 读可见性配置。`models: null` = 这个通道全部显示。键是**短前缀**（`wb`）而不是通道 id——隐藏一个模型时不该对每个号各勾一次。 */
adminRoutes.get('/api/models/visibility', (c) => {
  const visible = visibleModels();
  const out: Record<string, { listed: boolean; models: string[] | null }> = {};
  for (const channel of channels) {
    out[channel.idPrefix] = {
      listed: isListed(channel.idPrefix),
      models: visible[channel.idPrefix] ?? null,
    };
  }
  return c.json({ channels: out });
});

// 模型可见性。形状（只认 JSON）：
//   `{ prefix, action: 'toggle-list', listed: true|false }` 通道总闸 · `{ prefix, action: 'all' }` 恢复全部
//   `{ prefix, visible: ['m1','m2'] }` 只显示这些
// 放在 `/api/*` 而不是页面层：它改的是网关配置，和 `/api/models`、`/v1/models` 是同一个东西的两端。
adminRoutes.post('/api/models/visibility', async (c) => {
  const parsed = await readJsonBody(c);
  if (!parsed.ok) return c.json({ error: { message: parsed.message, type: 'bad_request' } }, 400);
  const body = parsed.body;
  const channel = channelByPrefix(typeof body.prefix === 'string' ? body.prefix : '');
  if (!channel) return c.json({ error: { message: `没有前缀 ${body.prefix}`, type: 'not_found' } }, 404);

  if (body.action === 'toggle-list') {
    const listed = body.listed === true;
    setListed(channel.idPrefix, listed);
    log(`模型列表: ${channel.idPrefix} ${listed ? '打开' : '关闭'}`);
    return c.json({ ok: true, prefix: channel.idPrefix, listed });
  }
  if (body.action === 'all') {
    // 「全部显示」连总闸一起打开：只重置勾选而总闸关着，页面会显示「全部」而 `/v1/models` 仍是空列表。
    setListed(channel.idPrefix, true);
    setVisibleFor(channel.idPrefix, null);
    log(`模型可见性: ${channel.idPrefix} 恢复全部显示`);
    return c.json({ ok: true, prefix: channel.idPrefix, listed: true, visible: null });
  }
  if (!Array.isArray(body.visible)) {
    return c.json({ error: { message: '需要一个 action，或 visible 数组', type: 'bad_request' } }, 400);
  }
  const ids = body.visible.filter((id: unknown) => typeof id === 'string' && id !== '');
  setVisibleFor(channel.idPrefix, ids);
  log(`模型可见性: ${channel.idPrefix} 只显示 ${ids.length} 个模型`);
  return c.json({ ok: true, prefix: channel.idPrefix, visible: ids });
});

// ---------------------------------------------------------------- 账本查询

/** 全局账本（14 天 × 三维度）。账号页的 `/api/accounts/:id/usage` 是单账号版，两者共用 `usageSummary()`，差别只是传不传 `account`。 */
adminRoutes.get('/api/usage', async (c) => {
  const account = new URL(c.req.url).searchParams.get('account');
  return c.json(await usageSummary({ account: account || null }));
});

/** 某一天按 24 小时拆开，`?date=YYYY-MM-DD` 必填。**费用在这一层算，不在前端算**：价目表和峰谷规则只有网关有，复制一份到 `web/src` 以后必然两边不一致且不报错。返回里的 `hours` 恒 24 项。 */
adminRoutes.get('/api/usage/hourly', (c) => {
  const params = new URL(c.req.url).searchParams;
  const date = params.get('date');
  if (!date) return c.json({ error: { message: '缺 date（YYYY-MM-DD）', type: 'bad_request' } }, 400);
  try {
    return c.json(
      usageHourly(date, {
        account: params.get('account') || null,
        provider: params.get('provider') || null,
      }),
    );
  } catch (error: any) {
    return c.json({ error: { message: error?.message || '单日用量查询失败', type: 'bad_request' } }, 400);
  }
});

/** 签到日志 + 账号显示名。日志里只有账号 id（`wb-1`），显示名是「通道 / 账号标签」——服务端知识，前端自己拼等于抄一遍。 */
adminRoutes.get('/api/checkin/log', (c) => {
  const accountNames: Record<string, string> = {};
  for (const channel of channels) {
    for (const account of accountsOf(channel.id)) {
      accountNames[account.id] = `${channel.label} / ${account.label}`;
    }
  }
  return c.json({ entries: readCheckinLog(), accountNames });
});
