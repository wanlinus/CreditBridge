import type { AppConfig } from '../../types.ts';
import { defineChannel } from '../types.ts';
import { LOOMY_VERSION, setLoomyLogger } from './auth.ts';
import { runLoomyLogin } from './login.ts';
import { buildModelList } from './models.ts';
import { chatLoomy, setLoomyUpstreamLogger } from './upstream.ts';
import { getLoomyCredits, setLoomyUsageLogger } from './usage.ts';

let config!: AppConfig;

const CHANNEL_ID = 'loomy';

export const loomyChannel = defineChannel({
  id: CHANNEL_ID,
  idPrefix: 'lo',
  label: 'Loomy',

  identity: {
    clientVersion: LOOMY_VERSION,
  },

  configure({ log, config: next }) {
    config = next;
    setLoomyLogger(log);
    setLoomyUpstreamLogger(log);
    setLoomyUsageLogger(log);
  },

  async modelsOf(account) {
    return buildModelList(account, config.defaultContextWindow, config.defaultMaxTokens);
  },

  async creditsOf(account) {
    return getLoomyCredits(account);
  },

  async probe(account) {
    const models = await buildModelList(account, config.defaultContextWindow, config.defaultMaxTokens);
    if (models.length === 0) throw new Error('Loomy 账号看不到任何模型');
    return {
      uid: account.credential?.userId || account.profile?.uid,
      username: account.profile?.username,
    };
  },

  async login(options) {
    return runLoomyLogin({ onPrompt: options?.onPrompt, signal: options?.signal });
  },

  async chatAs(account, request) {
    return chatLoomy(account, request);
  },
});
