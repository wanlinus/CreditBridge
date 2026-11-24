/**
 * 「今天有多少输入是全价算的」。
 *
 * 缓存是**前缀缓存**：首次出现的内容必然按全价计费，所以「一次性塞进几十万 token 新
 * 内容」和「在已有对话上追加一句」成本差几十倍，而在「已用积分」这一个数字上看不出
 * 区别。
 *
 * **必须按账号判断，不能按合计**：实测同一天 lo-1 命中 1.3%、wb-1 命中 99.8%，合计
 * 未命中只有 1.1%——真实异常被稀释掉了。反过来合计还会放大假异常：不报缓存的通道
 * `cachedTokens` 恒为 0，全部输入会被当成未命中。
 */

export interface AccountInputRow {
  account: string;
  promptTokens: number;
  cachedTokens: number;
}

export interface UncachedAccount {
  account: string;
  /** 未命中（全价）的 token 数。 */
  tokens: number;
  /** 未命中占比，0~1。 */
  ratio: number;
  /** 该账号的输入总量，给提示文案用。 */
  prompt: number;
}

/**
 * 找出「未命中占比最高」的账号。
 *
 * 只统计上游**确实报了缓存**的账号：全 0 意味着该通道不报这个字段（Trae），
 * 算进来等于凭空造出一个 100% 未命中。
 */
export function worstUncachedAccount(rows: readonly AccountInputRow[] | null | undefined): UncachedAccount | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  let worst: UncachedAccount | null = null;
  for (const row of rows) {
    const prompt = row?.promptTokens;
    const cached = row?.cachedTokens;
    if (typeof prompt !== 'number' || !Number.isFinite(prompt) || prompt <= 0) continue;
    // 0 表示「上游没报这个字段」，不是「真的全未命中」——跳过，否则会误报。
    if (typeof cached !== 'number' || !Number.isFinite(cached) || cached <= 0) continue;
    const tokens = prompt - cached;
    if (tokens <= 0) continue;
    const ratio = tokens / prompt;
    if (!worst || ratio > worst.ratio) {
      worst = { account: String(row.account ?? ''), tokens, ratio, prompt };
    }
  }
  return worst;
}

/** 正常多轮对话在 95% 上下，掉到一半以下基本只有「大段新内容一次性进来」一个原因。 */
export const UNCACHED_ALERT_RATIO = 0.5;

export function shouldWarnUncached(found: UncachedAccount | null): found is UncachedAccount {
  return found !== null && found.ratio >= UNCACHED_ALERT_RATIO;
}
