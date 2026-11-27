// 读请求体里的 JSON——**所有写端点都走这里**。
// 统一不是为了少几行，是为了行为一致：7 个写端点原先各写一遍 `JSON.parse`，`POST /api/keys` 那处
// 坏 JSON 静默当 `{}`，于是半截 JSON 能成功建出一把名叫「未命名」的 key。现在坏 JSON 一律 400，空 body 当 `{}`。
//
// 只返回原因不返回 Response：`/api/*` 用 `bad_request`、`/v1/*` 用 `gateway_error`（DSH 按 OpenAI 形状解析），
// 信封由调用点决定。
//
// **有大小上限**：`c.req.text()` 会把整个 body 读进内存，而 `/v1/chat/completions` 是绑在
// `0.0.0.0` 上的 Bearer 接口——不封顶就是一个「拿到 key 就能把进程内存打满」的 DoS 面。
// 上限按「一次对话能有多大」定，不是按「JSON 能有多大」定。

/** 请求体上限（字节）。16MB 够塞下很长的多轮对话，又远小于容器 `mem_limit`。 */
export const MAX_BODY_BYTES = 16 * 1024 * 1024;

export interface JsonBodyOk {
  ok: true;
  /** 一定是对象：空 body、非对象 JSON 都归一成 `{}`。 */
  body: Record<string, any>;
}

export interface JsonBodyFail {
  ok: false;
  message: string;
  /** 超限时是 `true`，路由据此回 413 而不是 400。 */
  tooLarge?: boolean;
}

/**
 * 读并解析 JSON 请求体。非对象（数组 / 数字 / `null`）也当 `{}`：调用点都按字段名取值，为它回 400 没有收益。
 *
 * `limit` 默认 `MAX_BODY_BYTES`，测试可以调小。
 */
export async function readJsonBody(c: any, limit = MAX_BODY_BYTES): Promise<JsonBodyOk | JsonBodyFail> {
  // 先看 `Content-Length`：能挡掉绝大多数大包，且不用先把字节读进内存。
  // 但它可以撒谎（分块传输时压根没有），所以下面还要按实际读到的字节数再兜一次。
  const declared = Number(c.req.header('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    return { ok: false, tooLarge: true, message: `请求体太大：${declared} 字节，上限 ${limit}` };
  }

  let raw: string;
  try {
    raw = await c.req.text();
  } catch (error: any) {
    return { ok: false, message: `读不到请求体：${error?.message || error}` };
  }
  // 兜一层：`Content-Length` 可能是假的，或分块传输时压根没有。`raw.length` 是 UTF-16 码元数，
  // 对纯 ASCII 等于字节数；含非 ASCII 时一个码元最多对应 3 字节，所以用 `length` 当门槛是**偏松**的，
  // 但已经足够挡住「几百万字符的 body 进 JSON.parse」这种量级。
  if (raw.length > limit) {
    return { ok: false, tooLarge: true, message: `请求体太大：超过 ${limit} 字节上限` };
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
