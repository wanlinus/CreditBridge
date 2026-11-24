/**
 * 签到：日志（`/api/checkin/log`）与一键签到（`/api/checkin/all`）。
 *
 * 单账号的签到状态在 `api/account-detail.ts`。这里是**所有账号的尝试历史**，
 * 一行一次（含失败和自动重试）。
 */
import { api } from './client';

/**
 * 一次签到的结果。
 *
 * `pending` 是**临时状态**：今天这一轮还没开始（Qoder 的活动每天 10:00 才开窗口）。
 * 它既不是失败也不是已签——调度器会在重试阶梯里再试。界面上要显示成中性的「未到时间」，
 * 不能归进「失败」（会让人以为系统坏了）。
 *
 * `skipped` 是**网关自己的决定**：两级开关把它关掉了，压根没打上游。它只出现在日志里，
 * 不会写进 `checkin_state`（明天开关一开照样要签）。显示成中性色 +「已跳过」。
 */
export type CheckinOutcome = 'checked' | 'already' | 'disabled' | 'pending' | 'error' | 'skipped';

export interface CheckinLogEntry {
  ts: number;
  account: string;
  channel: string;
  status: CheckinOutcome;
  /**
   * 这次拿到的积分。**可能根本没有这两个键**：失败行（`status: 'error'`）只写
   * `status` 和 `message`，`credits` / `streakDays` 不下发。声明成必有会让前端
   * 以为拿到的是 `null`，而实际是 `undefined`。
   */
  credits?: number | null;
  streakDays?: number | null;
  message?: string | null;
  /** `auto` = 每日调度，`manual` = 有人在页面上点的。 */
  source: 'auto' | 'manual';
}

export interface CheckinLogResponse {
  /** 新的在前。 */
  entries: CheckinLogEntry[];
  /** 账号 id → `通道 / 标签`。服务端算的，前端不自己拼。 */
  accountNames: Record<string, string>;
}

export function getCheckinLog(): Promise<CheckinLogResponse> {
  return api.get<CheckinLogResponse>('/api/checkin/log');
}

export interface CheckinAllResult {
  /** 逐账号结果。`channel` 是通道 id——和 `/api/checkin/log` 里的两个字段同名同义。 */
  results: { account: string; channel: string; status: CheckinOutcome; credits?: number | null; message?: string }[];
  okCount: number;
  failCount: number;
}

/**
 * 一键签到所有 `ready` 账号。
 *
 * 和自动调度的区别：**不重试、不跳过今天已签的**。用户手动点了，就要看到每个号
 * 此刻的真实结果。
 */
export function checkinAll(): Promise<CheckinAllResult> {
  return api.post<CheckinAllResult>('/api/checkin/all');
}
