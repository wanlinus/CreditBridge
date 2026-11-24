// 读请求体里的 JSON——**所有写端点都走这里**。
//
// 统一入口的理由不是行数，是**行为不一致**：7 个路由原先各写一遍 `JSON.parse`，
// 其中 `POST /api/keys` 那处坏 JSON 静默当 `{}`，于是半截 JSON 会成功建出一把名叫
// 「未命名」的 key，而调用方以为名字设好了。可选字段该允许缺席，不该允许坏掉。
//
// 现在统一：坏 JSON 一律 400，空 body 当 `{}`。
//
// 只返回原因不返回 Response：`/api/*` 用 `type: 'bad_request'`，`/v1/*` 用
// `gateway_error`（DSH 按 OpenAI 形状解析，不认识的 type 会当未知错误），
// 信封是调用点才知道的事。

export interface JsonBodyOk {
  ok: true;
  /** 一定是对象：空 body、非对象 JSON 都归一成 `{}`。 */
  body: Record<string, any>;
}

export interface JsonBodyFail {
  ok: false;
  message: string;
}

/**
 * 读并解析 JSON 请求体。
 *
 * 非对象（数组 / 数字 / `null`）也当 `{}`：调用点都是按字段名取值，非对象只会得到
 * 一堆 `undefined`，为它回 400 没有收益。
 */
export async function readJsonBody(c: any): Promise<JsonBodyOk | JsonBodyFail> {
  let raw: string;
  try {
    raw = await c.req.text();
  } catch (error: any) {
    return { ok: false, message: `读不到请求体：${error?.message || error}` };
  }
  if (!raw.trim()) return { ok: true, body: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: any) {
    return { ok: false, message: `请求体不是合法 JSON：${error.message}` };
  }
  const isObject = Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed);
  return { ok: true, body: isObject ? (parsed as Record<string, any>) : {} };
}
