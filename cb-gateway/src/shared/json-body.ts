// 读请求体里的 JSON——**所有写端点都走这里**。
// 统一不是为了少几行，是为了行为一致：7 个写端点原先各写一遍 `JSON.parse`，`POST /api/keys` 那处
// 坏 JSON 静默当 `{}`，于是半截 JSON 能成功建出一把名叫「未命名」的 key。现在坏 JSON 一律 400，空 body 当 `{}`。
//
// 只返回原因不返回 Response：`/api/*` 用 `bad_request`、`/v1/*` 用 `gateway_error`（DSH 按 OpenAI 形状解析），信封由调用点决定。

export interface JsonBodyOk {
  ok: true;
  /** 一定是对象：空 body、非对象 JSON 都归一成 `{}`。 */
  body: Record<string, any>;
}

export interface JsonBodyFail {
  ok: false;
  message: string;
}

/** 读并解析 JSON 请求体。非对象（数组 / 数字 / `null`）也当 `{}`：调用点都按字段名取值，为它回 400 没有收益。 */
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
