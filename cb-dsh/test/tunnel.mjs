import net from 'node:net';

const { openForward, closeForward, closeAll, listForwards, isLoopbackHost } = await import('../lib/tunnel.js');

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

function echoServer() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => socket.write(Buffer.concat([Buffer.from('echo:'), chunk])));
      socket.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function roundTrip(port, payload, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let received = '';
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, error: '超时' });
    }, timeoutMs);
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (chunk) => {
      received += chunk.toString();
      if (received.includes('echo:')) {
        clearTimeout(timer);
        socket.destroy();
        resolve({ ok: true, received });
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message });
    });
  });
}

console.log('--- 1. 环回判定 ---');
check('127.0.0.1 是环回', isLoopbackHost('127.0.0.1'), true);
check('127.0.0.53 是环回', isLoopbackHost('127.0.0.53'), true);
check('localhost 是环回', isLoopbackHost('localhost'), true);
check('[::1] 是环回', isLoopbackHost('[::1]'), true);
check('10.0.0.45 不是环回', isLoopbackHost('10.0.0.45'), false);
check('空值不是环回', isLoopbackHost(''), false);

console.log('\n--- 2. 自环守卫 ---');
const selfLoop = await openForward({ port: 18801, targetHost: '127.0.0.1', targetPort: 18801 });
check('同主机同端口被拒绝', selfLoop.ok, false);
check('拒绝时带原因', /绕回自己/u.test(selfLoop.error || ''), true);
check('被拒后没有留下监听', listForwards().length, 0);

console.log('\n--- 3. 真的搬字节 ---');
const { server: echo, port: echoPort } = await echoServer();
const probe = net.createServer();
const listenPort = await new Promise((resolve) => probe.listen(0, '127.0.0.1', () => resolve(probe.address().port)));
await new Promise((resolve) => probe.close(resolve));

const opened = await openForward({ port: listenPort, targetHost: '127.0.0.1', targetPort: echoPort });
check('转发开起来了', opened.ok, true);
check('listForwards 里有一条', listForwards(), [{ port: listenPort, targetHost: '127.0.0.1', targetPort: echoPort }]);

const trip = await roundTrip(listenPort, 'hello');
check('经转发拿到了回显', trip.ok, true);
check('内容对得上', trip.received, 'echo:hello');

const again = await openForward({ port: listenPort, targetHost: '127.0.0.1', targetPort: echoPort });
check('重复开同一端口是幂等的', again.ok, true);
check('没有多出一条', listForwards().length, 1);

console.log('\n--- 4. 关闭 ---');
check('closeForward 返回 true', closeForward(listenPort), true);
check('关干净了', listForwards(), []);
check('再关返回 false', closeForward(listenPort), false);
const afterClose = await roundTrip(listenPort, 'hello', 400);
check('关掉之后连不上了', afterClose.ok, false);

console.log('\n--- 5. closeAll ---');
const a = await openForward({ port: listenPort, targetHost: '127.0.0.1', targetPort: echoPort });
check('重新开起来', a.ok, true);
closeAll();
check('closeAll 清空', listForwards(), []);

console.log('\n--- 6. 非法端口 ---');
check('端口 0 被拒', (await openForward({ port: 0, targetHost: '10.0.0.45', targetPort: 18801 })).ok, false);
check('目标端口非法被拒', (await openForward({ port: 18801, targetHost: '10.0.0.45', targetPort: 70000 })).ok, false);

await new Promise((resolve) => echo.close(resolve));
closeAll();
console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
