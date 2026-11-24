/**
 * 上游 SSE 的传输层：发请求、分帧、解「外层包内层」的壳。
 *
 * 这一层只做三件与业务无关的事，谁消费、怎么用交给调用方——把 HTTP 分帧和 OpenAI
 * 语义混在一起的话，分帧没法单独测（要起真服务器），流式和非流式还会各写一遍。
 *
 * ## 上游的帧形状
 *
 * ```
 * data:{"headers":{...},"body":"<内层 JSON 字符串>","statusCodeValue":200,"statusCode":"OK"}
 * ```
 *
 * `body` 是**字符串**，要再 `JSON.parse` 一次才是 OpenAI chunk。三种特例：
 *
 * | 帧 | 含义 |
 * |---|---|
 * | `body === "[DONE]"` | 结束标志 |
 * | 外层没有 `body`，只有 `firstTokenDuration` 等 | 计时段，不是数据 |
 * | 内层有 `{code, message}` | 上游用「HTTP 200 + 内层 403」表达失败 |
 *
 * 最后一种是**最坑的**：只看 HTTP 状态码会以为请求成功，实际一个字都没回来。
 */

/** 一帧解出来的结果。四种互斥，`parseFrame` 只填其中一种。 */
export type UpstreamFrame =
  | { kind: 'chunk'; chunk: any }
  | { kind: 'done' }
  | { kind: 'timing'; timing: { firstTokenDuration?: number; totalDuration?: number; serverDuration?: number } }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'noise' };

/**
 * 解一帧 `data:` 后面的内容。
 *
 * 解不出来一律归 `noise` 而不是抛错：上游偶尔会插心跳帧，为了一个不认识的帧
 * 把整条流打断不值得。
 */
export function parseFrame(raw: string): UpstreamFrame {
  let outer: any;
  try {
    outer = JSON.parse(raw);
  } catch {
    return { kind: 'noise' };
  }
  if (!outer || typeof outer !== 'object') return { kind: 'noise' };

  // 计时段：没有 body，只有耗时
  if (outer.body === undefined) {
    if ('firstTokenDuration' in outer || 'totalDuration' in outer || 'serverDuration' in outer) {
      return { kind: 'timing', timing: outer };
    }
    return { kind: 'noise' };
  }

  const bodyRaw = outer.body;

  // 少数情况下 body 直接是对象
  if (typeof bodyRaw !== 'string') {
    return bodyRaw && typeof bodyRaw === 'object' ? { kind: 'chunk', chunk: bodyRaw } : { kind: 'noise' };
  }

  if (bodyRaw.trim() === '[DONE]') return { kind: 'done' };

  let inner: any;
  try {
    inner = JSON.parse(bodyRaw);
  } catch {
    return { kind: 'noise' };
  }

  // 内层报错：外层 HTTP 仍是 200，错误藏在这里
  if (inner && typeof inner === 'object' && inner.code !== undefined && inner.message !== undefined) {
    return { kind: 'error', code: String(inner.code), message: String(inner.message) };
  }

  return { kind: 'chunk', chunk: inner };
}

/**
 * 增量分帧器。
 *
 * SSE 以空行分帧，但网络分片**不保证**按帧边界到达——一帧可能跨好几个 chunk，
 * 也可能一个 chunk 里塞好几帧。所以必须攒缓冲、按空行切。
 *
 * CRLF 也要认：上游在 Windows 侧可能回 `\r\n\r\n`。
 */
export class SseFrameSplitter {
  private buffer = '';

  /** 喂一段数据，返回其中已经完整的帧（`data:` 后面的原文）。 */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const frames: string[] = [];

    for (;;) {
      const sep = this.findSeparator();
      if (sep === null) break;

      const rawFrame = this.buffer.slice(0, sep.index);
      this.buffer = this.buffer.slice(sep.index + sep.length);

      for (const line of rawFrame.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload !== '') frames.push(payload);
      }
    }

    return frames;
  }

  /** 找最近的空行分隔符，优先取出现更早的那个。 */
  private findSeparator(): { index: number; length: number } | null {
    const lf = this.buffer.indexOf('\n\n');
    const crlf = this.buffer.indexOf('\r\n\r\n');

    if (lf < 0 && crlf < 0) return null;
    if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, length: 4 };
    return { index: lf, length: 2 };
  }
}

/** 要发出去的请求。 */
export interface HttpRequestSpec {
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * 过滤请求头。
 *
 * - hop-by-hop（`connection` / `transfer-encoding`）由运行时管，传了会冲突
 * - `host` / `content-length` / `accept-encoding` 由运行时重算
 * - **空值丢弃**：`Cosy-Key` 为空时上游会判签名无效，发空串比不发更糟
 */
export function sanitizeHeaders(headers: Record<string, string>, body?: string): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (['host', 'connection', 'content-length', 'accept-encoding', 'transfer-encoding'].includes(lower)) continue;
    if (value === '') continue;
    filtered[lower] = value;
  }
  if (body !== undefined) filtered['content-length'] = String(Buffer.byteLength(body));
  return filtered;
}
