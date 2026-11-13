import type { Account, AccountProfile, AppConfig } from '../../types.ts';
import { defineChannel } from '../types.ts';
import { configureWorkBuddy, revokeWorkBuddySession, setLogger } from './auth.ts';
import { runWorkBuddyLogin } from './login.ts';
import {
  chatWorkBuddy,
  configureWorkBuddyUpstream,
  fetchWorkBuddyCatalog,
  setWorkBuddyUpstreamLogger,
} from './upstream.ts';
import {
  claimCheckin,
  getWorkBuddyUsage,
  readLastCheckin,
  setWorkBuddyUsageLogger,
} from './usage.ts';

let config!: AppConfig;

const CHANNEL_ID = 'workbuddy';

function withCreditMultiplier(name: string, credits: any) {
  const match = /^x\s*([0-9]+(?:\.[0-9]+)?)$/iu.exec(String(credits ?? '').trim());
  if (!match) return name;
  return `${name} · ${Number(match[1]).toFixed(2)}x`;
}

export const workbuddyChannel = defineChannel({
  id: CHANNEL_ID,
  idPrefix: 'wb',
  label: 'WorkBuddy',

  identity: {
    clientVersion: '5.9.3',
    channelVersion: '2.165.0',
    ideVersion: '5.9.3',
  },

  configure({ log, config: next }) {
    config = next;
    setLogger(log);
    setWorkBuddyUpstreamLogger(log);
    setWorkBuddyUsageLogger(log);
    configureWorkBuddyUpstream({
      ideVersion: workbuddyChannel.identity.ideVersion,
      appVersion: workbuddyChannel.identity.clientVersion,
      cliVersion: workbuddyChannel.identity.channelVersion,
    });
    configureWorkBuddy({
      clientVersion: workbuddyChannel.identity.clientVersion,
      channelVersion: workbuddyChannel.identity.channelVersion,
    });
  },

  async login(options) {
    return runWorkBuddyLogin({ onUrl: options?.onUrl, signal: options?.signal });
  },

  async probe(account: Account): Promise<AccountProfile> {
    const credits = await getWorkBuddyUsage(account);
    return credits.account ?? {};
  },

  async modelsOf(account) {
    const models = await fetchWorkBuddyCatalog(account);
    return models.map((model: any) => ({
      id: model.id,
      object: 'model',
      name: withCreditMultiplier(model.name, model.credits),
      context_length: model.contextWindow || config.defaultContextWindow,
      max_output_tokens: model.maxTokens || config.defaultMaxTokens,
      reasoning: model.supportsReasoning === true,
      input: model.supportsImages === true ? ['text', 'image'] : ['text'],
    }));
  },

  async catalogOf(account) {
    return fetchWorkBuddyCatalog(account);
  },

  async creditsOf(account) {
    return getWorkBuddyUsage(account);
  },

  async checkinStatusOf() {
    return null;
  },

  async checkinClaimOf(account) {
    return claimCheckin(account);
  },

  lastCheckinOf(account) {
    return readLastCheckin(account);
  },

  async logoutOf(account) {
    await revokeWorkBuddySession(account.credential);
  },

  async chatAs(account, request) {
    return chatWorkBuddy(account, request);
  },
});
