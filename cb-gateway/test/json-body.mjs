// 请求体读取：坏 JSON 一律 400、空 body 当 `{}`、**超限回 413**。
//
// 超限这条是安全边界：`c.req.text()` 会把整个 body 读进内存，而 `/v1/chat/completions`
// 绑在 `0.0.0.0` 上——不封顶就是一个「拿到 key 就能把进程内存打满」的面。
// 测试用假的 Hono context，不真起服务，所以可以把 limit 调得很小。
import { check, section, done } from './_helpers.mjs';

const { readJsonBody, MAX_BODY_BYTES } = await import('../src/shared/json-body.ts');

/** 造一个最小可用的 Hono context 形状。`contentLength` 传 `null` 表示不带头（分块传输）。 */
function ctx(body, { contentLength = null } = {}) {
  return {
    req: {
      header: (name) => (name.toLowerCase() === 'content-length' ? (contentLength === null ? undefined : String(contentLength)) : undefined),
      text: async () => body,
    },
  };
}

section('1. 正常路径');
check('空 body 当 {}', await readJsonBody(ctx('')), { ok: true, body: {} });
check('空白 body 当 {}', await readJsonBody(ctx('   \n ')), { ok: true, body: {} });
check('普通对象', await readJsonBody(ctx('{"a":1}')), { ok: true, body: { a: 1 } });

section('2. 坏 JSON 与非法形状');
const broken = await readJsonBody(ctx('{oops'));
check('坏 JSON → ok:false', broken.ok, false);
check('坏 JSON 带原因', /不是合法 JSON/u.test(broken.message), true);
check('数组当 {}（不为它回 400）', await readJsonBody(ctx('[1,2,3]')), { ok: true, body: {} });
check('数字当 {}', await readJsonBody(ctx('42')), { ok: true, body: {} });
check('null 当 {}', await readJsonBody(ctx('null')), { ok: true, body: {} });

section('3. 大小上限');
check('默认上限是 16MB', MAX_BODY_BYTES, 16 * 1024 * 1024);

// Content-Length 声明超限：不用真的造那么大的 body。
const declaredTooBig = await readJsonBody(ctx('{}', { contentLength: 100 }), 50);
check('Content-Length 超限 → ok:false', declaredTooBig.ok, false);
check('Content-Length 超限标 tooLarge', declaredTooBig.tooLarge, true);
check('超限消息说明字节数', /请求体太大/u.test(declaredTooBig.message), true);

// Content-Length 撒谎（说很小，实际很大）：靠读到的长度兜住。
const lying = await readJsonBody(ctx('x'.repeat(200), { contentLength: 10 }), 50);
check('Content-Length 撒谎也拦住', lying.tooLarge, true);

// 分块传输（没有 Content-Length）同样按实际长度拦。
const chunked = await readJsonBody(ctx('x'.repeat(200)), 50);
check('没有 Content-Length 也拦住', chunked.tooLarge, true);

// 恰好等于上限：放行（边界是「大于」才拒）。
const exact = await readJsonBody(ctx('{"a":1}'), 7);
check('恰好等于上限放行', exact.ok, true);

// 上限内的正常 body 不受影响。
check('上限内正常解析', await readJsonBody(ctx('{"a":1}'), 1000), { ok: true, body: { a: 1 } });

done();
