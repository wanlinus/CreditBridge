import { defineChannel } from '../types.ts';
import { configureTraeIdentity, mintSelfDeviceId, setTraeLogger } from './auth.ts';
import { effectiveLimits, fetchTraeModelConfig } from './config.ts';
import { chatTrae, setTraeUpstreamLogger, traeModelList } from './upstream.ts';
import { loginLoopback as traeLoginLoopback, runTraeLogin } from './login.ts';
import {
  claimCheckin,
  getCheckinStatus,
  getTraeUsage,
  readLastCheckin,
  setTraeUsageLogger,
} from './usage.ts';

export function contextOptions(max: number): number[] {
  const round = (value: number) => (Number.isInteger(value) && value % 1000 === 0 ? value : Math.round(value / 1000) * 1000);
  const values = [round(max * 0.5), round(max * 0.75), max].filter((v) => Number.isFinite(v) && v > 0);
  return [...new Set(values)].sort((a, b) => a - b);
}

export const traeChannel = defineChannel({
  id: 'trae',
  idPrefix: 'tr',
  label: 'Trae CN',

  identity: {
    clientVersion: '1.107.1',
    channelVersion: '2.3.102035',
    appVersion: '3.4.17',
  },

  configure(ctx) {
    setTraeLogger(ctx.log);
    setTraeUpstreamLogger(ctx.log);
    setTraeUsageLogger(ctx.log);
    configureTraeIdentity(traeChannel.identity);
  },

  async modelsOf(account) {
    return traeModelList(account);
  },

  async catalogOf(account) {
    const models = await fetchTraeModelConfig(account.credential);
    return models.map((model) => {
      const { contextWindow, maxTokens } = effectiveLimits(model);
      return {
        id: model.id,
        name: model.name,
        contextWindow,
        maxTokens,
        lengths: { default: contextWindow, options: contextOptions(contextWindow) },
        supportsImages: model.multimodal === true,
        supportsReasoning: model.reasoning,
      };
    });
  },

  async creditsOf(account) {
    const usage: any = await getTraeUsage(account);
    return {
      ...usage,
      totalRemain: usage.remaining,
      account: {
        uid: account.profile?.uid || account.credential?.userId,
        username: account.profile?.username || account.credential?.username,
        tokenExpiresAt: account.credential?.expiresAt ? new Date(account.credential.expiresAt).toISOString() : null,
        source: account.credential?.source,
      },
    };
  },

  async probe(account) {
    await getCheckinStatus(account);
    return {
      uid: account.credential?.userId,
      username: account.credential?.username,
    };
  },

  async checkinStatusOf(account) {
    return getCheckinStatus(account);
  },

  async checkinClaimOf(account) {
    return claimCheckin(account);
  },

  lastCheckinOf(account) {
    return readLastCheckin(account);
  },

  rotateDeviceIdOf() {
    return { selfDeviceId: mintSelfDeviceId() };
  },

  async login(options) {
    return runTraeLogin({ onUrl: options?.onUrl, signal: options?.signal });
  },

  loginLoopback() {
    return traeLoginLoopback();
  },

  async chatAs(account, request) {
    return chatTrae(account, request);
  },
});
