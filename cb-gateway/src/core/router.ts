import type { Account, Channel, ModelInfo } from '../types.ts';
import { channelByPrefix, channels } from '../channels/index.ts';
import { accountsOf, getAccount } from './accounts.ts';

export interface ParsedModelId {
  prefix: string;
  seq: number;
  modelId: string;
}

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
  if (!/^[1-9][0-9]*$/.test(seqText)) return null;
  return { prefix, seq: Number(seqText), modelId };
}

export function accountIdOf(channel: Pick<Channel, 'idPrefix'>, seq: number): string {
  return `${channel.idPrefix}-${seq}`;
}

export function externalModelId(account: Account, modelId: string): string {
  return `${account.id}/${modelId}`;
}

export interface ModelRoute {
  channel: Channel;
  account: Account;
  modelId: string;
  rawId: string;
}

export function resolveModel(raw: unknown): ModelRoute | null {
  const parsed = parseModelId(raw);
  if (!parsed) return null;
  const channel = channelByPrefix(parsed.prefix);
  if (!channel) return null;
  const account = getAccount(accountIdOf(channel, parsed.seq));
  if (!account || account.channelId !== channel.id) return null;
  return { channel, account, modelId: parsed.modelId, rawId: String(raw) };
}

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

function splitCreditSuffix(name: string): { base: string; suffix: string } {
  const at = name.lastIndexOf(' · ');
  if (at <= 0) return { base: name, suffix: '' };
  return { base: name.slice(0, at), suffix: name.slice(at) };
}

export function modelDisplayName(account: Account, upstreamName: string): string {
  const { base, suffix } = splitCreditSuffix(String(upstreamName ?? ''));
  const clean = base.replace(/[[\]]/gu, '').trim() || base;
  return `${account.id}/${clean}${suffix}`;
}

export function toExternalModel(channel: Channel, account: Account, model: ModelInfo) {
  return {
    ...model,
    id: externalModelId(account, model.id),
    name: modelDisplayName(account, model.name),
    owned_by: channel.id,
    accountStatus: account.status,
  };
}
