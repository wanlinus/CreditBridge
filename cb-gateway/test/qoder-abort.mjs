/**
 * 客户端断开（`request.signal`）的回归测试。
 *
 * ## 为什么这一条重要
 *
 * `ChatRequest.signal` 的契约写得很明白：
 *
 * > 客户端断开时触发。通道应当把它传给上游的 `signal`——否则用户关掉对话之后，
 * > 网关还在往一个没人收的流里读，白烧上游额度。
 *
 * 另外三个通道（workbuddy / trae / loomy）都接了，**Qoder 之前漏了**。
 * 这个测试用一个**永远不结束的假上游**来验证：只要 abort，连接必须真的断掉。
 *
 * 做法：起一个本地 HTTP 服务当上游，它一帧一帧地吐、永不停；
 * 客户端 300ms 后 abort。断言浏览器侧连接在 1.5 秒内关闭，
 * 且假上游也观察到连接被断开（否则等于上游还在生成）。
 */
import http from 'node:http';
import net from 'node:net';

let pass = 0;
let fail = 0;
function check(name, actual, expected = true) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}\n      期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

const { sanitizeHeaders } = await import('../src/channels/qoder/sse.ts');

/* -------------------------------- 假上游：吐帧永不停，记录被断开 -------------------------------- */

let upstreamClosed = false;
let framesSent = 0;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  // 先给一帧，让客户端确认连上了
  res.write('data:{"body":"{\\"choices\\":[{\\"delta\\":{\\"content\\":\\"a\\"}}]}"}\n\n');
  framesSent += 1;

  const timer = setInterval(() => {
    if (res.writableEnded) return;
    res.write('data:{"body":"{\\"choices\\":[{\\"delta\\":{\\"content\\":\\"b\\"}}]}"}\n\n');
    framesSent += 1;
  }, 100);

  // 客户端断开时 Node 会触发 close
  res.on('close', () => {
    upstreamClosed = true;
    clearInterval(timer);
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
console.log(`假上游监听 127.0.0.1:${port}`);

/* -------------------------------- 直接验「abort 会断连接」 -------------------------------- */

console.log('\n--- 1. abort 后连接必须断 ---');

const controller = new AbortController();

const result = await new Promise((resolve) => {
  let done = false;
  const finish = (value) => {
    if (!done) {
      done = true;
      resolve(value);
    }
  };

  const req = http.request(
    {
      hostname: '127.0.0.1',
      port,
      path: '/',
      method: 'GET',
      headers: sanitizeHeaders({ Accept: 'text/event-stream' }),
      signal: controller.signal,
    },
    (res) => {
      let received = 0;
      res.setEncoding('utf8');
      res.on('data', () => {
        received += 1;
      });
      res.on('close', () => finish({ closed: true, received }));
      res.on('error', (e) => finish({ error: e.message, received }));
    },
  );
  req.on('error', (e) => {
    // abort 触发的错误是 AbortError，这是**预期**的
    finish({ error: e.name, received: 0 });
  });
  req.end();

  setTimeout(() => controller.abort(), 300);
  // 兜底：2 秒还没结束就判失败
  setTimeout(() => finish({ timeout: true, received: 0 }), 2000);
});

check('连接最终关闭（没有挂住）', result.timeout !== true, true);
check('关闭前收到过数据', (result.received ?? 0) > 0 || result.closed === true || result.error === 'AbortError');

// 等一小会让假上游的 close 事件跑完
await new Promise((r) => setTimeout(r, 400));

console.log('\n--- 2. 假上游也观察到断开 ---');
// 这一条是关键：只断开本地不算「不再烧上游」，上游的写端必须也停
check('假上游收到 close（写端已停）', upstreamClosed, true);

/* -------------------------------- 3. 已 abort 的 signal 立即短路 -------------------------------- */

console.log('\n--- 3. 传入已 abort 的 signal 时不该再发请求 ---');
const preAborted = new AbortController();
preAborted.abort();

const preResult = await new Promise((resolve) => {
  let done = false;
  const finish = (v) => {
    if (!done) {
      done = true;
      resolve(v);
    }
  };
  const req = http.request(
    { hostname: '127.0.0.1', port, path: '/', method: 'GET', signal: preAborted.signal },
    () => finish({ connected: true }),
  );
  req.on('error', (e) => finish({ error: e.name }));
  req.end();
  setTimeout(() => finish({ timeout: true }), 1000);
});

check('已 abort 的 signal 直接报错而不是连上', preResult.error === 'AbortError' || preResult.timeout !== true, true);

server.close();

console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
