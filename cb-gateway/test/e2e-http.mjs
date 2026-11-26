// 端到端：真起一个网关，验证四层边界。
//
// 这个文件守的是**层的分界**，不是某个功能：
//
//   1. 前端产物（`/`、深链接、`/assets/*`）—— 公开、可缓存、永远是同一个壳
//   2. `/api/*` —— 要凭据；未登录回 401 JSON，**不回 302**
//   3. `/v1/*` —— 只认 Bearer key
//   4. **已经没有页面层了** —— 旧的表单动作（`POST /login`、`POST /accounts/<id>/toggle`…）
//      必须 404，一旦有人把它们加回来，这个文件就红
//
// 2026-11-13 SPA 转正时重写：之前那版断言的是 SSR 页面的 HTML（`<h1>概览</h1>`、
// `class="group"`、预渲染的 SVG），那些东西已经不存在了。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "cb-e2e-"));
process.env.QB_DATA_DIR = tempData;
// host/port 只认环境变量（config.json 里那两个键会被忽略，见 src/config.ts 的 FILE_KEYS）。
process.env.QB_HOST = "127.0.0.1";
process.env.QB_PORT = "7899";
fs.mkdirSync(path.join(tempData, "auth"), { recursive: true });
fs.writeFileSync(path.join(tempData, "config.json"), JSON.stringify({ verbose: false }, null, 2));

const auth = await import("../src/shared/gateway-auth.ts");
const keys = await import("../src/core/keys.ts");
auth.loadCredential();
auth.changePassword("admin", "probe-123456");
const { secret } = keys.createKey("e2e 测试");

// 两个假账号：没有它们，`/v1/models` 是空列表、`/api/accounts` 也没有行可验。
// 凭据是假的，所以真去打上游的动作会失败——那也是要覆盖的路径。
const accounts = await import("../src/core/accounts.ts");
accounts.loadAccounts();
const demo = accounts.addAccount({ channelId: "workbuddy", idPrefix: "wb", credential: { accessToken: "fake" }, label: "测试号" });
const traeDemo = accounts.addAccount({
  channelId: "trae",
  idPrefix: "tr",
  credential: { token: "fake", selfDeviceId: "2222222222222222", checkinDeviceId: "" },
  label: "Trae 测试号",
});

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

const base = "http://127.0.0.1:7899";
await import("../src/index.ts");

for (let i = 0; i < 60; i += 1) {
  try {
    const r = await fetch(base + "/");
    if (r.status > 0) break;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}

const bearer = { authorization: "Bearer " + secret };

// ---------------------------------------------------------------- 1. 前端产物

console.log("\n[前端产物]");
const shellRes = await fetch(base + "/");
check("GET / → 200", shellRes.status, 200);
check("GET / 是 HTML", (shellRes.headers.get("content-type") || "").includes("text/html"));
check("壳允许缓存但每次验证（no-cache）", shellRes.headers.get("cache-control"), "no-cache");
const shell = await shellRes.text();
check("壳有挂载点 #app", shell.includes('id="app"'));
// 壳是公开的：登录页必须先能加载出来，否则「没凭据 → 拿不到 JS → 渲染不出登录页」死锁。
check("壳不含服务端渲染的内容", shell.includes("<h1>"), false);

const assetPath = /src="(\/assets\/[^"]+\.js)"/u.exec(shell)?.[1];
check("壳引用了带哈希的打包产物", typeof assetPath, "string");
const assetRes = await fetch(base + (assetPath || "/assets/nope.js"));
check("静态资源 → 200", assetRes.status, 200);
check("静态资源可长缓存", assetRes.headers.get("cache-control"), "public, max-age=31536000, immutable");
check("静态资源是 JS", (assetRes.headers.get("content-type") || "").includes("javascript"));

// 深链接：刷新任意前端路由都要能拿回壳，否则 history 模式一刷新就 404。
for (const route of ["/accounts", "/accounts/wb-1", "/login", "/password", "/no-such-page"]) {
  const res = await fetch(base + route);
  const body = await res.text();
  check(`深链接 ${route} → 200 壳`, res.status === 200 && body.includes('id="app"'));
}

// ---------------------------------------------------------------- 2. 认证边界

console.log("\n[认证边界]");
for (const apiPath of ["/api/health", "/api/accounts", "/api/keys"]) {
  const res = await fetch(base + apiPath);
  check(`${apiPath} 无凭据 → 401`, res.status, 401);
  check(`${apiPath} 401 是 JSON`, (res.headers.get("content-type") || "").includes("json"));
}
const v1NoAuth = await fetch(base + "/v1/models");
check("/v1/models 无凭据 → 401", v1NoAuth.status, 401);
check("/v1/models 401 是 JSON", (v1NoAuth.headers.get("content-type") || "").includes("json"));

check("/api/health 带 Bearer → 200", (await fetch(base + "/api/health", { headers: bearer })).status, 200);
check("/v1/models 带 Bearer → 200", (await fetch(base + "/v1/models", { headers: bearer })).status, 200);

// 未登录打开页面**不再 302**：壳是公开的，前端自己跳登录页。
const pageNoAuth = await fetch(base + "/", { redirect: "manual" });
check("未登录打开 / 不重定向", pageNoAuth.status, 200);

// ---------------------------------------------------------------- 3. 登录 / 退出 / 改密

console.log("\n[会话]");
const badLogin = await fetch(base + "/api/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "wrong" }),
});
check("密码错 → 401", badLogin.status, 401);

const login = await fetch(base + "/api/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "probe-123456" }),
});
check("登录 → 200", login.status, 200);
const setCookie = (login.headers.getSetCookie ? login.headers.getSetCookie() : []).join(";");
const cookie = /gw_session=[^;]+/u.exec(setCookie)?.[0];
check("登录种下会话 Cookie", typeof cookie, "string");
check("登录后不再要求改密", (await login.json()).mustChangePassword, false);

check("会话可访问 /api/health", (await fetch(base + "/api/health", { headers: { cookie } })).status, 200);

// 单日 24 小时接口：参数错了要 400，不能 500（前端按 400 显示「日期不对」）。
const hourlyNoDate = await fetch(base + "/api/usage/hourly", { headers: { cookie } });
check("/api/usage/hourly 缺 date → 400", hourlyNoDate.status, 400);
const hourlyBadDate = await fetch(base + "/api/usage/hourly?date=2026-02-30", { headers: { cookie } });
check("/api/usage/hourly 非法日期 → 400", hourlyBadDate.status, 400);
const hourlyOk = await fetch(base + `/api/usage/hourly?date=${new Date().toISOString().slice(0, 10)}`, {
  headers: { cookie },
});
// 注意：这里用 UTC 日期算 `date`，只要今天在 UTC 和本地是同一天就成立；
// 跨零点那一小时可能落在「未来」，那种情况下也会是 400——所以只断言「不是 5xx」。
check("/api/usage/hourly 不返回 5xx", hourlyOk.status < 500);

const logout = await fetch(base + "/api/logout", { method: "POST", headers: { cookie } });
check("退出 → 200", logout.status, 200);
check("退出回 JSON", (logout.headers.get("content-type") || "").includes("json"));
check("退出后会话失效", (await fetch(base + "/api/health", { headers: { cookie } })).status, 401);
// 幂等：连点两下不该报错。
check("退出幂等（再退一次仍 200）", (await fetch(base + "/api/logout", { method: "POST", headers: { cookie } })).status, 200);

// ---------------------------------------------------------------- 4. 旧页面层必须已经消失

console.log("\n[旧页面层已删]");
const legacy = [
  ["POST", "/login"],
  ["POST", "/password"],
  ["POST", `/accounts/${demo.id}/toggle`],
  ["POST", `/accounts/${demo.id}/label`],
  ["POST", `/accounts/${demo.id}/rotate-device`],
  ["POST", "/checkin/all"],
  ["POST", "/settings/checkin"],
  ["POST", "/keys"],
  ["POST", "/models"],
];
for (const [method, legacyPath] of legacy) {
  const res = await fetch(base + legacyPath, { method, headers: { cookie: cookie || "" }, body: "" });
  check(`${method} ${legacyPath} → 404`, res.status, 404);
}

// 未知 API 路径必须回 JSON，不能落到壳上（否则调用方拿到 `Unexpected token '<'`）。
const unknownApi = await fetch(base + "/api/nope", { headers: bearer });
check("未知 API → 404", unknownApi.status, 404);
check("未知 API 是 JSON", (unknownApi.headers.get("content-type") || "").includes("json"));
// 未知页面路径回壳，由前端显示 404——服务端不该给 HTML 404。
const unknownPage = await fetch(base + "/nope");
check("未知页面 → 200 壳", unknownPage.status, 200);

// ---------------------------------------------------------------- 5. 账号动作（JSON 版）

console.log("\n[账号动作]");
const renamed = await (await fetch(base + `/api/accounts/${demo.id}`, {
  method: "PATCH",
  headers: { ...bearer, "content-type": "application/json" },
  body: JSON.stringify({ label: "改名了" }),
})).json();
check("改名生效", renamed.account.label, "改名了");

const disabled = await (await fetch(base + `/api/accounts/${demo.id}`, {
  method: "PATCH",
  headers: { ...bearer, "content-type": "application/json" },
  body: JSON.stringify({ status: "disabled" }),
})).json();
check("停用生效", disabled.account.status, "disabled");
// cooldown / invalid 是网关按上游反应写的，不接受人手指定——设一个只会让人以为真坏了。
check(
  "不能把状态直接设成 cooldown",
  (await fetch(base + `/api/accounts/${demo.id}`, {
    method: "PATCH",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify({ status: "cooldown" }),
  })).status,
  400,
);

const accountsApi = await (await fetch(base + "/api/accounts", { headers: bearer })).json();
check("/api/accounts 带余额字段", typeof accountsApi.accounts[0].totalRemain, "object");
check("/api/accounts 带能力位", ["canLogin", "canLogout", "canRotateDevice", "canVerify", "opensWindow"].every((k) => typeof accountsApi.channels[0][k] === "boolean"));
// `opensWindow` 决定前端要不要开空白窗接授权页。**表单式登录必须为 false**，
// 否则用户点「添加」会看到一个永远白着的标签页（豆包、Loomy 都中过）。
check(
  "表单式通道不开空白窗",
  accountsApi.channels.filter((c) => c.opensWindow === false).map((c) => c.id).sort(),
  ["doubao", "loomy"],
);

// 主动刷新积分的两个入口：只验路由边界（不存在的 id 必须 404，别掉进真上游）
check(
  "刷新积分：账号不存在 → 404",
  (await fetch(base + "/api/accounts/nope/credits", { method: "POST", headers: bearer })).status,
  404,
);
check(
  "刷新积分：通道不存在 → 404",
  (await fetch(base + "/api/channels/nope/credits", { method: "POST", headers: bearer })).status,
  404,
);

const beforeRotate = accounts.getAccount(traeDemo.id).credential.selfDeviceId;
const rotate = await (await fetch(base + `/api/accounts/${traeDemo.id}/rotate-device`, { method: "POST", headers: bearer })).json();
check("换设备号 changed=true", rotate.changed, true);
const afterRotate = accounts.getAccount(traeDemo.id).credential.selfDeviceId;
check("换号后 selfDeviceId 变了", afterRotate !== beforeRotate, true);
check("换号后仍是 16 位十进制", /^[1-9][0-9]{15}$/u.test(afterRotate), true);
check("换号不丢 token", accounts.getAccount(traeDemo.id).credential.token, "fake");

// 假凭据：检测会真打上游并失败，但**不能**把网关打成 500。
const verify = await fetch(base + `/api/accounts/${demo.id}/verify`, { method: "POST", headers: bearer });
check("检测失败也是规整响应（200/502）", [200, 502].includes(verify.status), true);

// ---------------------------------------------------------------- 6. 模型与可见性

console.log("\n[模型]");
const v1Models = await (await fetch(base + "/v1/models", { headers: bearer })).json();
const apiModels = await (await fetch(base + "/api/models", { headers: bearer })).json();
// 两个入口必须逐字节相同，否则「探测 17 个、能选 16 个」迟早发生。
check("/api/models 与 /v1/models 一致", JSON.stringify(apiModels), JSON.stringify(v1Models));

const visibility = await (await fetch(base + "/api/models/visibility", { headers: bearer })).json();
check("可见性可读", typeof visibility.channels, "object");
const toggleList = await (await fetch(base + "/api/models/visibility", {
  method: "POST",
  headers: { ...bearer, "content-type": "application/json" },
  body: JSON.stringify({ prefix: "wb", action: "toggle-list", listed: false }),
})).json();
check("关掉通道总闸", toggleList.listed, false);
check(
  "恢复全部显示",
  (await (await fetch(base + "/api/models/visibility", {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify({ prefix: "wb", action: "all" }),
  })).json()).listed,
  true,
);
// `back` 是旧的表单概念，随页面层一起删了：请求体里带它不该有任何效果。
const withBack = await (await fetch(base + "/api/models/visibility", {
  method: "POST",
  headers: { ...bearer, "content-type": "application/json" },
  body: JSON.stringify({ prefix: "wb", visible: ["m1"], back: "https://evil.example" }),
})).json();
check("visible 数组生效", withBack.visible, ["m1"]);

// ---------------------------------------------------------------- 7. 签到与配置

console.log("\n[签到与配置]");
const checkinAll = await (await fetch(base + "/api/checkin/all", { method: "POST", headers: bearer })).json();
check("一键签到返回逐账号结果", Array.isArray(checkinAll.results), true);
check("一键签到带成功/失败计数", typeof checkinAll.okCount === "number" && typeof checkinAll.failCount === "number");

const claim = await fetch(base + `/api/accounts/${demo.id}/checkin`, { method: "POST", headers: bearer });
check("手动领取返回 JSON", claim.status, 200);
const checkinLog = await import("../src/core/checkin-log.ts");
const entries = checkinLog.readCheckinLog();
check("手动领取写了日志", entries.length >= 1);
check("日志来源是 manual", entries[0].source, "manual");
check("日志记对了账号", entries[0].account, demo.id);
check("签到日志接口可读", (await fetch(base + "/api/checkin/log", { headers: bearer })).status, 200);

const cfg = await (await fetch(base + "/api/config", {
  method: "PATCH",
  headers: { ...bearer, "content-type": "application/json" },
  body: JSON.stringify({ checkinTime: "07:15" }),
})).json();
check("签到时间保存", cfg.checkinTime, "07:15");
check("签到时间写回 config.json", JSON.parse(fs.readFileSync(path.join(tempData, "config.json"), "utf8")).checkinTime, "07:15");
check(
  "非法签到时间被拒",
  (await fetch(base + "/api/config", {
    method: "PATCH",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify({ checkinTime: "25:00" }),
  })).status,
  400,
);

// ---------------------------------------------------------------- 8. 健康与元信息

console.log("\n[元信息]");
const health = await (await fetch(base + "/api/health", { headers: bearer })).json();
check("/api/health ok", health.ok, true);
check("/api/health 账号数", health.accounts.length, 2);
// **不写死数字**：通道会继续加。写死 3 的版本在加 Loomy 那天就过时了。
const { channels: registeredChannels } = await import("../src/channels/index.ts");
check("/api/health 通道数与注册表一致", Object.keys(health.channels).length, registeredChannels.length);
check("/api/health 通道带 idPrefix", health.channels.workbuddy.idPrefix, "wb");
check("/api/health 带签到时间", health.checkinTime, "07:15");
check("/api/channels 给外观", Array.isArray((await (await fetch(base + "/api/channels", { headers: bearer })).json()).channels), true);

// ---------------------------------------------------------------- 9. 删账号

console.log("\n[删除]");
check("删除账号", (await fetch(base + `/api/accounts/${traeDemo.id}`, { method: "DELETE", headers: bearer })).status, 200);
check("删完再查 → 404", (await fetch(base + `/api/accounts/${traeDemo.id}`, { headers: bearer })).status, 404);
check("删不存在的账号 → 404", (await fetch(base + `/api/accounts/${traeDemo.id}`, { method: "DELETE", headers: bearer })).status, 404);

console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
