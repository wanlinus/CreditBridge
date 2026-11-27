/**
 * 单账号详情：`/api/accounts/:id`、`/credits`、`/checkin`。
 *
 * 三个端点分开是为了**按需刷新**：详情页打开时一起拉，但「手动签到」「重新检测」
 * 只需要重拉其中一个。把它们合成一个巨型端点会让「签到完余额变了」这种情况整页重排。
 */
import { api } from './client';

export interface AccountDetail {
  account: {
    id: string;
    channelId: string;
    channelLabel: string;
    idPrefix: string;
    seq: number;
    label: string;
    status: string;
    statusMessage: string | null;
    profile: { uid?: string | null; username?: string | null; domain?: string | null } | null;
    createdAt: number;
    /** 凭据的**存在性**，不是内容。 */
    hasCredential: boolean;
    credentialSource: string | null;
    tokenExpiresAt: string | null;
  };
  channel: {
    id: string;
    label: string;
    idPrefix: string;
    /** 报给上游的版本串（`clientVersion` / `channelVersion` / `ideVersion`）。 */
    identity: Record<string, string>;
    multiAccount: boolean;
    canLogin: boolean;
    canLogout: boolean;
    canRotateDevice: boolean;
    canVerify: boolean;
    canCheckin: boolean;
  };
}

/**
 * 额度包。三家上游的字段名不同，归一化的责任在通道。
 *
 * 不导出：只有 `CreditsView` 用得到它，外部拿到 `CreditsView` 就够了，
 * 单独 import 它是多余的入口（knip 也把它报成死导出）。
 */
interface CreditsPackage {
  name: string;
  limit: number;
  used: number;
  expireAt: number | null;
}

export interface CheckinRecord {
  date: string;
  status: 'checked' | 'already' | 'disabled' | 'error';
  credits?: number | null;
  extraCredits?: number;
  streakDays?: number | null;
  message?: string;
  at?: number;
  code?: number;
}

export interface CreditsView {
  provider: string;
  supported: boolean;
  /** 成功时才有；`error` 存在时没有。 */
  totalRemain?: number;
  packages?: CreditsPackage[];
  account?: Record<string, unknown>;
  error?: string;
  label: string;
  idPrefix: string;
  /** 今天本地的签到记录；没有就是 `null`。 */
  checkin: CheckinRecord | null;
  loggedIn: boolean;
  canLogin: boolean;
  canLogout: boolean;
}

/** 上游真实的签到状态。只有 `CheckinEnvelope` 用得到，不单独导出。 */
interface CheckinStatus {
  enable: boolean;
  checkedIn: boolean;
  credits: number;
  extraCredits: number;
  didCheckedIn?: boolean;
}

export interface CheckinEnvelope {
  ok: true;
  /** 本机日历日。 */
  today: string;
  /** 本地记录（今天签没签、拿到了多少）。 */
  last: CheckinRecord | null;
  /** 上游状态；通道没有状态接口时是 `null`。 */
  status: CheckinStatus | null;
  /** 查上游失败的原因。 */
  error?: string;
  canClaim: boolean;
}

export function getAccount(id: string): Promise<AccountDetail> {
  return api.get<AccountDetail>(`/api/accounts/${encodeURIComponent(id)}`);
}

export function getAccountCredits(id: string): Promise<CreditsView> {
  return api.get<CreditsView>(`/api/accounts/${encodeURIComponent(id)}/credits`);
}

export function getAccountCheckin(id: string): Promise<CheckinEnvelope> {
  return api.get<CheckinEnvelope>(`/api/accounts/${encodeURIComponent(id)}/checkin`);
}

/** 手动领取。返回通道原始结果（`checked` / `already` / `error`）。 */
export function claimCheckin(id: string): Promise<{ ok: boolean; result: CheckinRecord }> {
  return api.post<{ ok: boolean; result: CheckinRecord }>(`/api/accounts/${encodeURIComponent(id)}/checkin`);
}
