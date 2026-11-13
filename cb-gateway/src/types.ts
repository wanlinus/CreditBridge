export interface AppConfig {
  host: string;
  port: number;
  defaultContextWindow: number;
  defaultMaxTokens: number;
  verbose: boolean;
}

export interface ChannelIdentity {
  clientVersion: string;
  channelVersion?: string;
  ideVersion?: string;
  appVersion?: string;
}

export interface TraeCredential {
  token: string;
  refreshToken: string;
  userId: string;
  username: string;
  refreshBase: string;
  expiresAt: number;
  refreshExpiresAt: number;
  machineId: string;
  checkinDeviceId: string;
  selfDeviceId?: string;
  privateKeyPEM?: string;
  publicKeyPEM?: string;
  source: string;
}

export interface ModelInfo {
  id: string;
  object: string;
  name: string;
  context_length: number;
  max_output_tokens: number;
  reasoning?: boolean;
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  input?: string[];
}

export interface CatalogModel {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  lengths?: { default?: number; options: number[] };
  supportsImages: boolean;
  supportsReasoning: boolean;
  reasoning?: unknown;
}

export type AccountStatus = 'ready' | 'cooldown' | 'invalid' | 'disabled';

export interface AccountProfile {
  uid?: string;
  username?: string;
  domain?: string;
}

export interface Account {
  id: string;
  channelId: string;
  seq: number;
  label: string;
  credential: any;
  status: AccountStatus;
  cooldownUntil: number | null;
  statusMessage: string | null;
  profile: AccountProfile;
  createdAt: number;
  updatedAt: number;
}

export interface AccountInfo {
  uid?: string;
  username?: string;
  domain?: string;
  tokenExpiresAt?: string | null;
  source?: string;
}

export interface UsagePackage {
  name: string;
  limit: number | null;
  used: number;
  expireAt: number | null;
}

export interface Credits {
  provider: string;
  supported: boolean;
  totalRemain: number;
  packages?: UsagePackage[];
  account?: AccountInfo;
  [key: string]: unknown;
}

export type CheckinStatusKind = 'checked' | 'already' | 'disabled' | 'pending' | 'error';

export interface CheckinRecord {
  date: string;
  status: CheckinStatusKind;
  credits?: number | null;
  extraCredits?: number;
  streakDays?: number | null;
  message?: string;
  at?: number;
  code?: number;
  outcome?: string;
  transient?: boolean;
}

export interface CheckinStatus {
  enable: boolean;
  checkedIn: boolean;
  credits: number;
  extraCredits: number;
  didCheckedIn?: boolean;
}

export type ChatUsage = Record<string, unknown> & {
  credit?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

export interface ChatRequest {
  body: Record<string, any>;
  signal?: AbortSignal;
  onUsage?: (usage: ChatUsage | null) => void;
}

export type ChatOutcome =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'stream'; status: number; headers: Record<string, string>; body: AsyncIterable<string> };

export interface ChannelContext {
  log: (...args: unknown[]) => void;
  config: AppConfig;
}

export interface LoginPrompt {
  id: string;
  label: string;
  placeholder?: string;
  inputType?: 'text' | 'number' | 'password';
  submitLabel?: string;
}

export interface LoginResult {
  credential: any;
  profile?: AccountProfile;
  label?: string;
}

export interface Channel {
  id: string;

  idPrefix: string;

  label: string;

  multiAccount?: boolean;

  reportsTokens?: boolean;

  identity: ChannelIdentity;

  configure?(ctx: ChannelContext): void;

  warmup?(account: Account): Promise<void>;

  login?(options?: {
    onUrl?: (url: string) => void;
    onPrompt?: (prompt: LoginPrompt) => Promise<string>;
    signal?: AbortSignal;
  }): Promise<LoginResult>;

  loginLoopback?(): { port: number; path: string } | null;

  probe?(account: Account): Promise<AccountProfile>;

  modelsOf(account: Account): Promise<ModelInfo[]>;

  catalogOf?(account: Account): Promise<CatalogModel[]>;

  creditsOf(account: Account): Promise<Credits>;

  checkinStatusOf?(account: Account): Promise<CheckinStatus | null>;

  checkinClaimOf?(account: Account): Promise<CheckinRecord>;

  lastCheckinOf?(account: Account): CheckinRecord | null;

  rotateDeviceIdOf?(account: Account): Record<string, any> | null;

  logoutOf?(account: Account): Promise<void>;

  chatAs(account: Account, request: ChatRequest): Promise<ChatOutcome>;
}
