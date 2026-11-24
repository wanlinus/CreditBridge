// 模型 id 的拼装与拆解，以及模型显示名的生成。
//
// 对外 id 是 `<idPrefix>-<seq>/<上游模型 id>`（`wb-1/hy4free`）：前半段回答「用哪个
// 通道的哪个号」，后半段是上游认的模型名。用 `/` 当分隔符是实测过的——DSH 的 OpenAI
// 适配器只把 id 放进请求体的 `model` 字段，URL 由 `baseURL` 拼，对 id 只校验非空不重复。
//
// 拆分规则：**按第一个 `/` 切**，剩下的整段是模型 id（上游模型名自己带斜杠也不会切错）；
// 前半段再按第一个 `-` 切前缀和序号——前缀的校验里禁掉了 `-`，所以没有歧义。

import type { Account, Channel, ModelInfo } from '../types.ts';
import { channelByPrefix, channels } from '../channels/index.ts';
import { accountsOf, getAccount } from './accounts.ts';
import { applyModelSettings } from '../shared/model-settings.ts';

export interface ParsedModelId {
  /** 通道短前缀，`wb`。 */
  prefix: string;
  /** 账号序号，`1`。 */
  seq: number;
  /** 上游认的模型 id。 */
  modelId: string;
}

/** 拆 id。形状不对返回 `null`，不猜。 */
export function parseModelId(raw: unknown): ParsedModelId | null {
  if (typeof raw !== 'string') return null;
  const slash = raw.indexOf('/');
  if (slash <= 0 || slash === raw.length - 1) return null;
  const head = raw.slice(0, slash);
  const modelId = raw.slice(slash + 1);
  const dash = head.indexOf('-');
  if (dash <= 0 || dash === head.length - 1) return null;
  const prefix = head.slice(0, dash);
  const seqText = head.slice(dash + 1);
  // 序号是十进制正整数、不带前导零：`wb-01` 和 `wb-1` 是同一个号，但只认后者，
  // 否则同一个账号会有两种写法，账本里就分家了。
  if (!/^[1-9][0-9]*$/.test(seqText)) return null;
  return { prefix, seq: Number(seqText), modelId };
}

/** 账号 id 就是短前缀加序号（`wb-1`）。 */
export function accountIdOf(channel: Pick<Channel, 'idPrefix'>, seq: number): string {
  return `${channel.idPrefix}-${seq}`;
}

/** 对外 id：`wb-1/hy4free`。 */
export function externalModelId(account: Account, modelId: string): string {
  return `${account.id}/${modelId}`;
}

export interface ModelRoute {
  channel: Channel;
  account: Account;
  /** 上游认的裸模型 id，转发前要写回 `body.model`。 */
  modelId: string;
  /** 调用方原样给的那串 id，报错时原样回显。 */
  rawId: string;
}

/**
 * 把请求里的模型 id 解析成「通道 + 账号 + 上游模型 id」。
 *
 * 任何一段对不上都返回 `null`——路由层再调 `unknownModelMessage()` 拿人话，
 * 这里不抛错是为了让「哪种情况不存在」的判定集中在一个地方。
 *
 * **不做跨账号兜底**：`wb-1/hy4free` 里的 1 号不存在时直接 404，不会退到 2 号。
 * 指定的语义就是「这个号」（见 private/docs/v2 §4.4）。
 */
export function resolveModel(raw: unknown): ModelRoute | null {
  const parsed = parseModelId(raw);
  if (!parsed) return null;
  const channel = channelByPrefix(parsed.prefix);
  if (!channel) return null;
  const account = getAccount(accountIdOf(channel, parsed.seq));
  if (!account || account.channelId !== channel.id) return null;
  return { channel, account, modelId: parsed.modelId, rawId: String(raw) };
}

/** 解析失败时给调用方看的话。尽量说清是「哪一段」不对。 */
export function unknownModelMessage(raw: unknown): string {
  const shape = '要写成 <通道短前缀>-<账号序号>/<上游模型>，例如 wb-1/hy4free';
  if (typeof raw !== 'string' || raw === '') return `模型 id 不能为空：${shape}`;

  const parsed = parseModelId(raw);
  if (!parsed) return `不认识模型 id "${raw}"：${shape}`;

  const channel = channelByPrefix(parsed.prefix);
  if (!channel) {
    return `没有短前缀为 "${parsed.prefix}" 的通道（现有：${channels.map((item) => item.idPrefix).join(' / ')}）`;
  }
  const accountId = accountIdOf(channel, parsed.seq);
  if (!getAccount(accountId)) {
    const siblings = accountsOf(channel.id).map((item) => item.id);
    return `没有账号 ${accountId}${siblings.length ? `（现有：${siblings.join('、')}）` : `（${channel.label} 还没加过账号，去管理台登录一个）`}`;
  }
  return `账号 ${accountId} 没有模型 "${parsed.modelId}"`;
}

// ---------------------------------------------------------------- 显示名

/**
 * 上游的模型名和倍率是拼在一起的（`Hy4 · 0.00x`），按**最后一个** ` · ` 切开。
 *
 * 为什么是最后一个：上游的描述里可能自己带 ` · `（`某模型 · 0.5x · beta`），
 * 只有最后一段才是倍率。切不开就当整个是模型名，后面不加倍率——**不能因为上游
 * 改了个后缀就把名字拼错**。
 */
function splitCreditSuffix(name: string): { base: string; suffix: string } {
  const at = name.lastIndexOf(' · ');
  if (at <= 0) return { base: name, suffix: '' };
  return { base: name.slice(0, at), suffix: name.slice(at) };
}

/**
 * 模型显示名：`wb-1/快速 · 0.15x`。
 *
 * 用账号 id 而不是 label：`wb-1` 里的 `wb` 已经说清是哪个通道，label 只是同一个号的
 * 别名，方括号三段式在模型选择器里又长又吵。分隔符用 `/` 而不是 `-`——账号 id 自己
 * 就带 `-`，再拼会出现连续横线。
 *
 * 倍率后缀原样保留；切不开就不加，不能因为上游改了个后缀就把名字拼错。
 */
export function modelDisplayName(account: Account, upstreamName: string): string {
  const { base, suffix } = splitCreditSuffix(String(upstreamName ?? ''));
  // 模型本名里可能自带方括号（`[beta]xxx`），去掉——单段名字里没有配对的结构了，
  // 留着只会让人以为还有别的字段。
  const clean = base.replace(/[[\]]/gu, '').trim() || base;
  return `${account.id}/${clean}${suffix}`;
}

/**
 * 把一个账号的模型列表翻译成对外的项。
 *
 * **网关设置在这里落地**：`context_length` / `max_output_tokens` 取用户在 `/models`
 * 页配的值（没配就是上游值），`reasoningEfforts` / `defaultReasoningEffort` 由通道能力
 * 推导。所以 `/v1/models` 和 `/api/models` 报出去的就是「实际生效」的那一份，插件
 * 只管照抄，不需要自己再算一遍——这正是「所有兜底都在网关」的落点。
 *
 * `accountStatus` 不是 OpenAI 标准字段（`ready` / `cooldown` / `invalid`），给管理台
 * 和排错用；DSH 会忽略它，只看 `id` / `name` / 上下文。
 */
export function toExternalModel(channel: Channel, account: Account, model: ModelInfo) {
  return {
    ...applyModelSettings(channel.idPrefix, model),
    id: externalModelId(account, model.id),
    name: modelDisplayName(account, model.name),
    owned_by: channel.id,
    accountStatus: account.status,
  };
}
