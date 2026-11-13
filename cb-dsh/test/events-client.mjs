import http from 'node:http';

const { startEventStream } = await import('../lib/events-client.js');

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

function fakeGateway() {
  const state = { requests: [], sockets: new Set() };
  const server = http.createServer((req, res) => {
    state.requests.push({ url: req.url, auth: req.headers.authorization || '' });
    if (req.url !== '/api/events') {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization !== 'Bearer good-key') {
      res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":{"message":"unauthorized"}}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.write(': connected\n\n');
    res.write('event: login\ndata: {"type":"login","channelId":"trae","state":"running","loopback":{"port":18801,"path":"/authorize"}}\n\n');
    res.write('event: login\ndata: {"type":"login",\ndata: "state":"done"}\n\n');
    state.sockets.add(res);
    req.on('close', () => state.sockets.delete(res));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

const { server, state, port } = await fakeGateway();
const baseUrl = `http://127.0.0.1:${port}`;

const received = [];
const logs = [];
const stream = startEventStream({
  baseUrl,
  apiToken: 'good-key',
  onEvent: (event) => received.push(event),
  log: (line) => logs.push(line),
});

const deadline = Date.now() + 3000;
while (received.length < 2 && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

check('带上了 Bearer 凭据', state.requests[0]?.auth, 'Bearer good-key');
check('打的是 /api/events', state.requests[0]?.url, '/api/events');
check('收到两条事件（注释行没算）', received.length, 2);

check('第一条是登录开始', received[0]?.state, 'running');
check('事件类型标出来了', received[0]?.__event, 'login');
check('loopback 端口解析对了', received[0]?.loopback?.port, 18801);
check('loopback 路径解析对了', received[0]?.loopback?.path, '/authorize');

check('多行 data 被拼成一个 JSON', received[1]?.state, 'done');
check('多行 data 的其余字段也在', received[1]?.type, 'login');

check('记了「已连接」日志', logs.some((line) => line.includes('事件流已连接')), true);
check('connected() 为 true', stream.connected(), true);

stream.stop();
const countAtStop = received.length;
await new Promise((resolve) => setTimeout(resolve, 120));
check('stop 之后不再收事件', received.length, countAtStop);
check('stop 之后 connected() 为 false', stream.connected(), false);

console.log('\n--- 凭据不对时 ---');
const badLogs = [];
const badStream = startEventStream({
  baseUrl,
  apiToken: 'bad-key',
  onEvent: () => {
    throw new Error('不该收到事件');
  },
  log: (line) => badLogs.push(line),
});
await new Promise((resolve) => setTimeout(resolve, 250));
check('401 不抛错、只记日志', badLogs.some((line) => line.includes('HTTP 401')), true);
check('401 之后 connected() 为 false', badStream.connected(), false);
badStream.stop();

for (const socket of state.sockets) socket.destroy();
await new Promise((resolve) => server.close(resolve));

console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
