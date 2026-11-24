// 用无头 Chrome 截一张网关页面的图，走 CDP（不装 puppeteer，零依赖）。
//
// ## 为什么必须带专用 --user-data-dir
//
// **永远不要用 `Get-Process chrome | Stop-Process` 收尾。** 那条命令会把用户正在用的
// 浏览器一起关掉，而且强制结束不留崩溃转储、不写 Application Error——表现就是
// "Chrome 无缘无故崩了"，2026-11-13 因此白查两轮。
//
// 所以这里的做法是：每个实例一个专用 `--user-data-dir`（默认放 `%TEMP%\cb-headless-*`），
// 收尾只杀「命令行里带这个目录」的进程。
//
// ## 用法
//
//   node shot.mjs <url> <输出png> [--login 密码] [--port 9229] [--width 1280] [--height 900]
//
// `--login` 会先 POST /api/login 拿 Cookie，再注入浏览器——网关所有 /api/* 都要登录，
// 不登录只能看到登录页。
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const args = process.argv.slice(2);
const url = args[0];
const outFile = args[1];
if (!url || !outFile) {
  console.error('用法: node shot.mjs <url> <输出png> [--login 密码] [--port 9229] [--width 1280] [--height 900]');
  process.exit(1);
}
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const password = opt('login', null);
const port = Number(opt('port', 9229));
const width = Number(opt('width', 1280));
const height = Number(opt('height', 900));

const CHROME =
  [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].find((p) => fs.existsSync(p)) || 'chrome.exe';

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-headless-'));
const origin = new URL(url).origin;

async function cdp(ws, method, params = {}) {
  const id = ++cdp.seq;
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      ws.removeEventListener('message', onMessage);
      msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
cdp.seq = 0;

(async () => {
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      `--window-size=${width},${height}`,
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  );

  // 等 CDP 端口起来
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl || null;
    } catch {
      /* 还没起来 */
    }
  }
  if (!wsUrl) throw new Error('Chrome CDP 没起来');

  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });

  await cdp(ws, 'Page.enable');
  await cdp(ws, 'Runtime.enable');

  // 登录：拿 Cookie 再注入。网关 /api/* 全要登录，不登录只能看到登录页。
  if (password) {
    const res = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password }),
    });
    if (!res.ok) throw new Error(`登录失败 HTTP ${res.status}`);
    const cookies = res.headers.getSetCookie?.() || [];
    for (const raw of cookies) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      await cdp(ws, 'Network.setCookie', {
        name: pair.slice(0, eq),
        value: pair.slice(eq + 1),
        domain: new URL(origin).hostname,
        path: '/',
      });
    }
    console.log(`登录: ${res.status}，注入 ${cookies.length} 个 Cookie`);
  }

  await cdp(ws, 'Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp(ws, 'Page.navigate', { url });
  // 图表要等数据到位，给足时间
  await new Promise((r) => setTimeout(r, 6000));

  const { data } = await cdp(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(outFile, Buffer.from(data, 'base64'));
  console.log(`截图: ${outFile}`);

  ws.close();
  chrome.kill();
})().catch((e) => {
  console.error('失败:', e.message);
  process.exitCode = 1;
});
