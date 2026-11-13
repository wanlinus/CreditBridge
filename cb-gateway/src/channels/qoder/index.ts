import type { AppConfig } from '../../types.ts';
import { defineChannel } from '../types.ts';
import { deviceFlowLogin } from './auth.ts';
import { ensureCli, isCliLoggedIn, isInstalled, loginCli, QODER_CLI_VERSION, resolveManifest, setCliLogger } from './cli.ts';
import { buildModelList, getModelNames, invalidateModelCache, setModelsLogger } from './models.ts';
import { setProcessLogger, shutdown } from './process.ts';
import { chatQoder, setQoderUpstreamLogger } from './upstream.ts';
import {
  claimCheckin,
  getCheckinStatus,
  getQoderCredits,
  readLastCheckin,
  setQoderUsageLogger,
} from './usage.ts';

let config!: AppConfig;

const CHANNEL_ID = 'qoder';

let channelLog: ((...args: unknown[]) => void) | null = null;

function logCliStatus(message: string) {
  if (channelLog) channelLog(`[qoder] ${message}`);
}

export const qoderChannel = defineChannel({
  id: CHANNEL_ID,
  idPrefix: 'qd',
  label: 'Qoder',

  multiAccount: false,

  reportsTokens: false,

  identity: {
    clientVersion: QODER_CLI_VERSION,
  },

  configure({ log, config: next }) {
    config = next;
    channelLog = log;
    setCliLogger(log);
    setModelsLogger(log);
    setProcessLogger(log);
    setQoderUpstreamLogger(log);
    setQoderUsageLogger(log);
  },

  async modelsOf() {
    const names = await getModelNames();
    return buildModelList(names, config.defaultContextWindow, config.defaultMaxTokens);
  },

  async creditsOf(account) {
    return getQoderCredits(account);
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

  async probe(account) {
    const credits = await getQoderCredits(account);
    if (!isInstalled()) {
      const manifest = resolveManifest();
      logCliStatus(`CLI 未安装（期望版本 ${manifest.version}，来源 ${manifest.source}）；首次对话时会自动下载`);
    } else if (!isCliLoggedIn()) {
      logCliStatus('CLI 已安装但未登录；对话不可用，需要在管理台点「登录」');
    }
    return credits.account ?? {};
  },

  async login(options) {
    const result = await deviceFlowLogin(options);
    invalidateModelCache();
    ensureCli().catch(() => {
    });
    await loginCli({ onUrl: options?.onUrl, signal: options?.signal });
    return result;
  },

  async chatAs(account, request) {
    return chatQoder(account, request);
  },
});

process.on('exit', () => {
  try {
    shutdown();
  } catch {
  }
});
