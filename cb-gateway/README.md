# CreditBridge Gateway（cb-gateway）

一个 OpenAI 兼容的网关：**对外说标准 OpenAI 协议**（DSH、其他 agent、任何 OpenAI 客户端都能直接接），**对内翻译成五家上游的私有协议**，用**指定账号**的积分付账。单进程、无构建步骤（`node src/index.ts` 直接跑，Node 22.18+ 原生剥离类型）。

| 通道 id | idPrefix | label | 上游 | 模型来源 |
|---|---|---|---|---|
| `workbuddy` | `wb` | WorkBuddy | `copilot.tencent.com` | 上游 `/v3/config` 实时目录 |
| `trae` | `tr` | Trae CN | `trae-api-cn.mchost.guru` | 服务端配置 `batch_get_detail_param` |
| `qoder` | `qd` | Qoder | `openapi.qoder.com.cn`（额度/签到）+ COSY 签名的 HTTP SSE（对话） | 上游 `/algo/api/v2/model/list` |
| `loomy` | `lo` | Loomy | `loomyad.xunfei.cn` | 上游 `/api/v1/models` |
| `doubao` | `db` | 豆包 | `www.doubao.com` | 上游 `/alice/slot/action_bar_v3/brief_list` |

**豆包这个通道有三点和其他四个不一样**，用之前要知道：

- **登录有两条路**：`/accounts` 点「+ 添加」后先选方式——
  **短信验证码**（输手机号 → 收验证码，单账号能全自助完成）或**导入 cookie**
  （从豆包客户端复制 Cookie 整串）。**手机号绑了多个豆包账号时必须走 cookie**：
  选号那一步被上游风控要求二次验证（`error_code 2046`），网关复现不了。
  这条边界是实测的，不是没做。
- **不报 token 用量**（`reportsTokens: false`）。对话的 SSE 里没有任何计数字段，
  所以它在概览页上只有余额、没有用量数字——那里显示的是 `—`，不是 0。
- **对话有独立风控**。高频请求会回 `710022004`（`error_msg` 写的是 `rate limited`，
  但那是固定文案，真实原因是风控要真人验证）。网关把它映射成 `429`、账号标 `cooldown`；
  遇到就在豆包客户端里过一次验证，或降低频率。
  **调试时连国内站不要走代理**：出口 IP 从家宽变成境外机房会直接触发风控。

内部结构与不变量见 [`ARCHITECTURE.md`](ARCHITECTURE.md)，每条路径的请求/响应形状见 [`API.md`](API.md)，v2 重构的取舍见 [`../private/docs/architecture-decisions.md`](../private/docs/architecture-decisions.md)。

---

## 模型 id

```
<idPrefix>-<账号序号>/<上游模型 id>

wb-1/hy4free      →  WorkBuddy 通道、1 号账号、hy4free 这个模型
wb-2/hy4free      →  同一个模型，但花 2 号账号的额度
tr-1/glm-5.3      →  Trae 通道、1 号账号
qd-1/auto         →  Qoder（只能有一个号，见下）
```

显示名是网关生成的：**账号 id + 模型本名 + 倍率**，`/` 分隔（DSH 的模型选择器只有一个扁平列表，账号必须进名字）：

```
wb-1/Hy4 · 0.00x
wb-2/Hy4 · 0.00x        ← 同一个模型，两个账号各一套 id
tr-1/GLM-5.3 · 0.08x
qd-1/Auto
```

拼法是把上游返回的 name 按**最后一个** ` · ` 切成「模型本名」和「倍率后缀」。切不开就当整个是模型名，不加倍率——上游改格式时不能把名字拼错。用的是**账号 id 而不是 label**：label 是给人改的别名，改了不该让 DSH 里已经存下的名字跟着漂。

`id` 只做寻址，不做展示；中文只出现在 `name` 和账号的 `label` 上。

---

## 起服务

**推荐用镜像**（不用装 Node）：

```bash
docker run -d --name cb-gateway -p 7801:7801 -v cb-data:/app/data \
  ghcr.io/wanlinus/creditbridge:latest
```

数据在 `cb-data` 卷里。要让别的机器访问，容器必须监听 `0.0.0.0`——`compose.yaml` 里已经给了 `QB_HOST=0.0.0.0`。

**改代码时本地跑**：

```bash
cd cb-gateway
npm install          # 只有 hono + @hono/node-server 两个运行时依赖
npm run build:web    # 前端产物，必须先构建
node src/index.ts    # 或 npm start
```

监听地址只认 `QB_HOST` / `QB_PORT` 环境变量（容器里靠 `compose.yaml` 给），**不在 `config.json` 里**。`config.json` 只剩 `checkinTime` / `defaultContextWindow` / `defaultMaxTokens` / `verbose` 四项；`checkinTime`（每天签到时间）在 `/settings` 改、写回 config.json 并原地生效。**模型可见性和模型设置不在这个文件里**——它们在 `channel_visibility` / `model_setting` 两张表（`data/gateway.db`），改完立刻生效、不用重启。

依赖安装与容器构建需要能访问 npm registry。开发机走代理：

```powershell
$env:HTTPS_PROXY='http://127.0.0.1:7897'; $env:HTTP_PROXY='http://127.0.0.1:7897'
```

第一次启动会在 `gateway_credential` 表里建默认账号 `admin` / `admin`——**改密之前除 `/api/login` `/api/logout` `/api/password` 外一律 403**（一律 JSON）。前端产物（壳、`/assets/*`）不受影响，否则登录页自己都加载不出来。

容器部署用同目录的 `Dockerfile` + `compose.yaml`。CI 会自动构建镜像推 GHCR（`.github/workflows/ci.yml`）。

---

## 账号

**一个账号 = 一个上游的号**，落在 `account` 表（`credential` 存 JSON 文本）。序号只增不减：删掉 `wb-2` 不会让 `wb-3` 变成 `wb-2`，否则账本和 DSH 里存的模型 id 全部指向错的账号。

管理台 `/accounts` **按通道分组**：每个通道一块，块里是它的账号，块头是通道名 + `idPrefix` + 这个通道的能力（几个号、支不支持自助登录），块尾是**这个通道自己的「添加账号」**。

为什么这么排：数据是两级的（通道 → 账号），而登录这个动作发生在通道上——你想的是「给 WorkBuddy 加一个号」，不是「添加一个账号再选它属于谁」。所以「能加几个」「能不能登录」写在通道那一行上，加满时按钮直接禁掉并说明原因（`multiAccount: false` 的通道只能挂一个号，目前五个都允许挂多个），没登录过的通道也照样有一块，否则你看不到「这里可以加一个」。

每个账号：

- **添加账号** → 页面给出授权链接并**自动新开一个标签页**（被浏览器拦了会显示可点的链接）→ 浏览器里完成 → 页面自动刷新。网关**不打开浏览器**（它常常部署在没有浏览器的机器上），开标签页是页面脚本干的。
- **取消登录** → 登录卡片上有个「取消登录」。登录最长等 5 分钟，点错了或不想登了可以直接放弃；取消后迟到的授权结果**不会**落成账号。再点一次「添加账号」也是取消旧的、起新的（不是排队）。
- **改名**：只影响页面上的显示（账号卡片、详情页的标题）。**模型显示名用的是账号 id，不是 label**。
- **停用**：可逆，只是不再发请求；模型 id 仍然在列表里。
- **删除**：会让它名下那批模型 id 从列表消失，页面会说明影响并要求确认。
- **重新登录**：同一个号再登一次，覆盖凭据。上游 uid 相同的登录不会产生两个文件。

**状态机**（只有这四种，自动切换你不需要手动管）：

| 状态 | 什么情况 | 请求时 |
|---|---|---|
| `ready` | 正常 | 放行 |
| `cooldown` | 上游回 429 且没说清是哪个模型（或通道级限流） | 429，提示几点后可再用；**到点自动回 ready** |
| `invalid` | 上游回 401（凭据坏了） | 503，提示去管理台重新登录 |
| `disabled` | 你在管理台手动停用 | 503 |

**429 不封账号，也不记「模型冷却」。** WorkBuddy 的限流（`code 6004`）是**按模型**的：2026-11-10 实测同一个 `wb-1` 下 `deepseek-v4.1-flash` 回 429 时，`hy4free` / `glm-5.3` / `deepseek-v4-pro` 全是 200，上游原话就是「您也可以切换其他模型继续使用」。

所以 429 时账号保持 `ready`、同账号的其他模型照常能用，**429 原样回给客户端**由它自己退避。2026-11-10 曾经为此加过一个落盘的「模型级冷却」（`core/model-cooldown.ts`），2026-11-13 删掉了，三条理由：① 上游不发 `Retry-After`，那个 5 分钟兜底是猜的，和上游说的重置时间无关；② 它在转发**之前**就拦，上游其实已经恢复时也照样拒绝——从没试过；③ 它的「请求成功就清冷却」永远不可达（冷却命中时前面已经 return 了）。

**五个通道都支持多账号**。Qoder 曾经只能挂一个（`multiAccount: false`），理由是对话依赖常驻 CLI 的登录态、那是机器级的一份——CLI 于 2026-11-22 移除后这个前提消失了：每个号有独立的 `dt-` 凭据和独立签名，不存在串号问题。豆包的风控也是按 cookie 计的，多个号互不影响。

### Trae 登录（容器部署下最容易踩坑）

Trae 的登录要把浏览器重定向回网关，而浏览器在你自己的机器上、网关在容器里，所以容器必须发布一个回调端口，并用环境变量告诉网关「对外地址是什么」：

```yaml
# compose.yaml
environment:
  QB_TRAE_LOGIN_HOST: 0.0.0.0        # 容器里必须监听所有网卡
  QB_TRAE_LOGIN_PORT: 18801          # 固定端口，和下面发布的同一个
  QB_TRAE_CALLBACK_BASE: http://127.0.0.1:18801
ports:
  - "18801:18801"
```

`QB_TRAE_CALLBACK_BASE` 必须写成**环回**（`127.0.0.1`）：Trae 的授权页只肯把浏览器跳回环回地址，
填内网 IP（`http://192.168.1.100:18801`）时它不跳（2026-11-09 实测两次）。

那么浏览器上的 `127.0.0.1:18801` 怎么到容器里？**插件替你做**：网关在登录开始的瞬间通过
`GET /api/events`（SSE）推一条事件，插件 host 半边（`cb-dsh/lib/tunnel.js`）就在本机开一条
TCP 转发 `127.0.0.1:18801` → `<网关 host>:18801`，登录结束自动关。**不需要手动 `ssh -L`**。

> 手动兜底：插件没跑（DSH 没开、key 没配）时可以自己开隧道
> `ssh -N -L 18801:127.0.0.1:18801 user@192.168.1.100`，效果一样。

登录时**必须打开登录页而不是授权页**：直接开授权页时，浏览器已有登录态的那次会停在页面不跳转，回调端口一直收不到东西。

**授权 URL 里的 `device_id` 不能为空**（2026-11-13 实测，之前是可以为空的老路径）。授权页会把它原样
转给 `POST /api.trae.cn/cloudide/api/v3/trae/oauth/GetPCAuthCode`，空串上游回
`10101 无效参数：{__Message.field}.`，表现是授权页报错、浏览器不跳回 `127.0.0.1:18801`、
网关那边的登录任务一直挂着（日志里连 `回调收到` 都没有）。

排查方式（这次用的）：MITM 抓包看 `GetPCAuthCode` 的**请求体**，再用浏览器里的会话 Cookie
重放这个接口做对照——`DeviceID:""` 回 400，`DeviceID` 填任意非空值（16 位纯数字、32 hex、UUID
都试过）回 200 带 `AuthCode`。所以现在登录一开始就 `mintSelfDeviceId()` 造一个号，**三处用同一个值**：
授权 URL 的 `device_id`/`x_device_id`、换令牌的 `DeviceInfo.DeviceID`、凭据里的 `selfDeviceId`。
三处不一致会回 `401 20405 Device proof required`。

**连续点两次「添加账号」不会再把网关弄崩**：回调端口被占用时先退避重试约 3 秒（`server.close()`
是异步的），还不行就抛一句可读的话（`回调端口 18801 已被占用——上一次登录任务还没结束…`）。
以前 `'error'` 事件没人接，EADDRINUSE 会直接把进程带走，容器重启、所有登录任务丢失。

Trae 的凭据里带一对 EC P-256 设备密钥（刷新时签 `DeviceProof` 用），**跟着账号文件走**——放在共用文件里的话第二个号登录会把第一个号的密钥覆盖掉，它过期后再也刷不回来。

---

## 认证

两类凭据，**互相独立**——改密码不影响 key，吊销 key 也不影响浏览器登录：

| 调用方 | 凭据 | 怎么配 |
|---|---|---|
| 浏览器 | 会话 Cookie `gw_session` | `POST /api/login` 后种下，`HttpOnly` + `SameSite=Lax`，12 小时 |
| 程序（DSH、脚本、插件） | `Authorization: Bearer sk-…` | `/keys` 页新建，整串只显示一次；填进插件面板的输入框（插件再写进 DSH 凭据库） |

会话存在内存里：**容器重启后浏览器要重新登录**，但上游账号凭据和 API key 都在 `data/` 里，不受影响。

### `/keys`：API key 管理

一个 key 是一张访问票据，不是账号密码。多台机器各配一把，丢了一台就吊销那一个；给别人用时给独立一把，随时能单独停。

- **明文只显示一次**：`api_key` 表里只存 `salt` + `hash`（scrypt，不可逆），明文只在创建成功那一刻出现在页面上——**列表里没有「查看」按钮，因为真的取不回来**。忘了复制就删掉重建一把，改一处客户端配置而已。格式是 `sk-` + 48 位字母数字（51 字符，和 OpenAI 的 key 同形），列表上另留前 12 个字符（`sk-AbCdEfGhi…`）用来分辨。
  - 代价：`keys.json` 泄露即等同 key 泄露。它是 `0600` + gitignore，且 `data/accounts/` 里的上游凭据本来就是明文，没有突破这个目录既有的边界。
- **`keys.json` 只在进程内缓存一次，改文件不会热生效**：手改、或者从别的进程写进去（比如在容器里跑个脚本建 key），**必须重启网关**才会被认出来，否则一律 401。正常路径（`/keys` 页、`POST /api/keys`）走的是同一个进程，写完就刷新缓存，不受影响。
- 停用立刻生效（下一次请求就是 401），可以再启用；删除不可撤销。
- 改密码**不会**让已有 key 失效。

**Basic 认证和 v1 的明文 token 都删了**：v1 在 `gateway.json` 里存过一段明文 `token` 当机器凭据，还认过 `Authorization: Basic`，v2 都不认，也没留兼容分支。升级后 profile 里旧的 `Bearer` 会立刻 401——浏览器登录后去 `/keys` 建一把新的换上就行。

---

## 路径分成三层

这不是命名习惯，是**边界**：看一个路径就知道它属于谁、谁能调、返回什么。

| 层 | 前缀 | 谁在用 | 认证 | 返回 |
|---|---|---|---|---|
| **前端 SPA** | 其余一切（`/`、`/accounts`、`/accounts/<id>`、`/keys`、`/models`、`/settings`、`/login`、`/password`、`/assets/*`） | 浏览器 | **不需要**（公开静态文件） | HTML / JS / CSS |
| **管理 API** | `/api/*` | SPA / 程序 / 脚本 / 插件 | Bearer key **或** 会话 Cookie | JSON |
| **OpenAI 兼容** | `/v1/*` | DSH | **只认** Bearer key | JSON / SSE |

两条规矩：

- **`/v1/*` 只放协议本身**。网关私有的东西（credits、usage、models/settings、shutdown、plugin-probe）一律去 `/api/*`，否则「哪条是 OpenAI 规范、哪条是我们加的」要逐个记。
- **写操作全部在 `/api/*`**。2026-11-13 之前还有「页面层 + 页面动作层」（8 个 SSR 页面 + 17 条表单 POST），那两层已经删干净：服务端不再出任何 HTML 页面，登录页也在 SPA 里。

**前端产物为什么公开**：它只是几个静态文件，不含任何数据。登录页在**没有任何凭据**时必须能加载出来，否则就是「想进门先给我门钥匙」。数据全在后面那两层。

**未知路径怎么走**：`/api/*` 和 `/v1/*` 回 404 JSON（路径里带 `api/`、`v1/` 段也算，所以 v1 时代的 `/workbuddy/v1/models` 一样 404）；其余回 SPA 壳，由前端路由显示 404 页。

### OpenAI 兼容（对外主入口）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/models` | **账号 × 模型**：每个账号一套 id，过可见性。账号失效时 id 仍在（带 `accountStatus`），只有删账号才消失 |
| POST | `/v1/chat/completions` | 按 id 找通道 + 账号 → 转发 → SSE 或聚合 JSON |

### 管理 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | **只读本地状态，不发网络请求**。`accounts` 数组 + `channels` 通道元数据（`idPrefix` / `identity` / `listed` / `multiAccount`）。**要认证**，所以它不是容器 healthcheck 的探针（那个探 `/login`） |
| GET | `/api/channels` | 通道的**外观**清单：`label` + `letter` + `icon`（data URI，读 `src/channels/<id>/icon.png`）。缓存 5 分钟。图标不塞进 `/health`，也不塞进徽标接口 |
| GET | `/api/models` | 同 `/v1/models`，**逐字节相同**（共用 `modelListPayload()`）。给设置页探测和脚本用 |
| GET | `/api/models/visibility` | 当前可见性配置：`{ channels: { wb: { listed, models } } }`（`models: null` = 全部显示） |
| POST | `/api/models/visibility` | 保存可见性（JSON）。`action=toggle-list` 切通道总开关，`action=all` 恢复全部，`visible: [...]` 只显示这些 |
| GET | `/api/config` | 当前配置（`checkinTime` 等） |
| PATCH | `/api/config` | 保存签到时间（`HH:MM`），写回 `config.json` 原地生效 |
| POST | `/api/login` | JSON `{username, password}` → 200 + `Set-Cookie`；失败 401 |
| POST | `/api/logout` | 销毁会话 + 清 Cookie。**幂等**：会话早过期也回 200 |
| POST | `/api/password` | 改密（`current` / `next` / `confirm`）。强制改密和常规改密是**同一条** |
| GET | `/api/accounts` | 账号列表 + 余额 + 今日消耗 + 通道能力位（`canLogin` / `canLogout` / `canRotateDevice` / `canVerify`） |
| GET | `/api/accounts/:id` | 单账号详情：账号字段 + 通道元数据与能力位。**不发网络请求**，只读本地文件 |
| PATCH | `/api/accounts/:id` | 改 label，或把状态切成 `disabled` / `ready`（`cooldown` / `invalid` 只由网关写） |
| DELETE | `/api/accounts/:id` | 删账号（连凭据一起） |
| POST | `/api/accounts/:id/verify` | 真打一次上游验凭据（会消耗一次请求，别放进轮询） |
| POST | `/api/accounts/:id/logout` | 让上游注销会话（账号保留） |
| POST | `/api/accounts/:id/rotate-device` | 换这个号的设备号；`changed: false` 表示通道不支持 |
| POST | `/api/accounts/:channel/login` | 起一次登录任务，回 `{ ok, task }` |
| GET | `/api/accounts/:channel/login/:taskId` | 登录进度（`running` / `done` / `error` / `cancelled`，带授权 `url` 和短信 `prompt`） |
| POST | `/api/accounts/:channel/login/:taskId/answer` | 回填 `prompt`（短信验证码等），JSON `{value}` |
| DELETE | `/api/accounts/:channel/login/:taskId` | 取消这次登录。**幂等**：已结束的任务也回 200 |
| DELETE | `/api/accounts/:channel/login` | 取消该通道所有在跑的登录 |
| GET | `/api/accounts/:id/credits` | 单账号余额的完整快照（面板和账号页读它） |
| GET | `/api/accounts/:id/badge` | 徽标要显示的两个字符串：`amount` + `today`（文案由网关算，见 `core/badge.ts`）。60 秒轮询，所以只回文本不含图标 |
| GET | `/api/accounts/:id/usage` | 单账号账本：`totals` / `today` / `daily` / `byModel` / `byAccount` / `todayByAccount` / `recent` |
| GET / POST | `/api/accounts/:id/checkin` | 签到状态 / 手动领取 |
| POST | `/api/checkin/all` | 一键签到所有 `ready` 账号，回逐账号结果 |
| GET | `/api/checkin/log` | 签到日志 + 账号显示名（`通道 / 标签`） |
| PATCH | `/api/accounts/:id/checkin-switch` | 账号级自动签到开关（`{enabled}`） |
| GET | `/api/keys` | key 列表（含明文 `secret`，供「查看原文」；老记录为 `null`） |
| POST | `/api/keys` | 新建，明文 `secret` 在响应里回出来（`201`）；明文另有一处从 2026-11-11 起存进 `keys.json` 供回看 |
| PATCH | `/api/keys/:id` | 改名 / 停用 / 启用 |
| DELETE | `/api/keys/:id` | 删除 |
| GET / POST | `/api/models/settings` | 模型设置：上下文窗口 / 最大输出 / 缺省思考档。**只有这一份**（`model_setting` 表），DSH 插件只是把 `/api/models` 报出来的值照抄进 profile |
| GET | `/api/events` | **SSE 事件流**（长连接）：登录开始/结束时推 `login` 事件，插件据 `loopback.port` 开本机 TCP 转发 |
| GET | `/api/plugin-probe` | 插件侧诊断打点，追加到 `data/logs/plugin-probe.log` |
| POST | `/api/shutdown` | 关闭网关进程 |

### 前端页面（`web/`）

界面是 Vue 3 SPA，源码在 `cb-gateway/web/src/`，构建产物 `web/dist` 由网关同源托管。
**服务端不渲染任何页面**：所有路由都在 `web/src/router/index.ts` 里，未知路径由前端显示 404 页。

| 路径 | 说明 |
|---|---|
| `/` | **概览（只读）**：总余额、今日消耗、14 天消耗图（按通道/模型/账号切换）、通道与账号、最近请求 |
| `/accounts` | **账号（只动）**：按通道分组，行内检测 / 停用 / 改名 / 重登 / 换设备号 / 删除 |
| `/accounts/<id>` | 账号详情：**一页三 tab**（概览 / 用量 / 模型），账号头常驻 |
| `/keys` | API key：明文默认打码、可显示/复制；新建那把直接摊开 |
| `/models` | 可见性：通道总闸 + 逐模型勾选，改一下立即保存 |
| `/checkin` | 签到日志 + 一键签到；失败行整行标红 |
| `/settings` | 改密 + 签到时间 + 网关信息 |
| `/login`、`/password` | 登录 / 强制改密（不带导航条） |

七个页面全部实现，没有占位页了。账号的三个二级路径共用 `AccountDetailView`，tab 由路径决定（`/usage`、`/models`）。

视觉语言只有一份：`web/src/styles/tokens.css`（色板、圆角、定宽）+ `web/src/layouts/ShellLayout.vue`（导航 → 面包屑 → 标题 → 内容）。状态色只有四档（`--ok` / `--warn` / `--bad` / `--muted`），不要在各页面引入新色。

自测（都要带 key）：

```bash
curl -H "Authorization: Bearer sk-…" http://192.168.1.100:7801/v1/models
curl -H "Authorization: Bearer sk-…" http://192.168.1.100:7801/api/health
curl -H "Authorization: Bearer sk-…" http://192.168.1.100:7801/api/accounts/wb-1/credits
curl -H "Authorization: Bearer sk-…" "http://192.168.1.100:7801/api/accounts/wb-1/usage"
curl -H "Authorization: Bearer sk-…" http://192.168.1.100:7801/api/models/visibility
```

---

## 模型可见性

两个筛子，都在 `channel_visibility` 表（`data/gateway.db`）里，改完立刻生效、**不用重启**。在 `/models` 页勾选即可，**不要手改库**：

- **总闸**：`false` = 整个通道的模型都不出现在模型列表里。缺行 = 开。
- **清单**：写了数组就只显示列出的那些，**顺序也按列表来**；缺行 / `null` = 全部显示。
- 键是**短前缀**（`wb` / `tr` / `qd`），**不含账号**——想隐藏「某个模型」时不该对每个号各勾一次，加一个号也不用重勾。
- 两级都只影响 `/v1/models` 的输出，**不影响对话**：被隐藏的模型仍可直接调用。
- **全是默认值时不写行**：只有被显式改过的通道才在表里留一行，让人能一眼看出「哪些是配过的」。

---

## 数据与文件

```
data/
├─ config.json                 checkinTime / 两个默认值 / verbose（手改入口；host、port 走环境变量）
├─ gateway.db                  库：账本 / 账号 / key / 密码 / 签到 / 模型设置 / 可见性（WAL 模式）
├─ state/qoder-models.json      Qoder 模型名单缓存（6 小时 TTL，删了会自动重取）
├─ state/trae-identity.json    Trae 的机器级设备身份
├─ state/qoder-identity.json   Qoder 的设备身份
└─ logs/                       按天日志
```

v4 迁库前的残留（`usage.jsonl`、`auth/`、`accounts/`、`state/checkin/`、`state/checkin-log.jsonl`、`state/trae-spend/`）和 Qoder 常驻 CLI 时代的 `cli/`（88MB）已于 2026-11-23 从生产删除。**它们确实没有任何代码读**：删之前核对过 `usage_record` 9591 行覆盖全部时间范围、`checkin_state`/`checkin_log` 有 5/140 行、`account` 表 6 个号齐全，删完 6 个账号仍全部 `ready`、签到读的是库里的当天记录。

`state/` 现在只剩三个有效文件：`trae-identity.json` / `qoder-identity.json`（设备身份，必须跨登录稳定）和 `qoder-models.json`（模型名单缓存，删了会自动重取）。

`data/` 已 gitignore，**里面有明文 token，不得提交**。备份要连 `gateway.db-wal` 一起拷：WAL 模式下未 checkpoint 的行在 `-wal` 里，只拷主文件会丢数据（实测过）。布局本身就是事实，**不写迁移代码**（不写迁移代码）。

---

## 测试与检查

```bash
npm run check      # tsc --noEmit，0 error 才算过
npm test           # 14 套全跑，不需要网关、不需要真上游
```

| 命令 | 查什么 |
|---|---|
| `npm run check` | 类型检查。禁 `enum` / `namespace` / 构造器参数属性 / 装饰器（剥离器做不了） |
| `npm run check:web` | `vue-tsc --noEmit`：前端 SPA 的类型检查 |
| `npm run test:router` | 模型 id 拆解、显示名生成、报错文案 |
| `npm run test:visibility` | 可见性的读写、坏文件容错 |
| `npm run test:accounts` | 账号存储、序号不回收、状态机、凭据刷新（并发单飞）、ISO 有效期 |
| `npm run test:keys` | API key：生成格式、明文 secret 可回看、前缀筛候选、停用立刻失效、删除、最后使用时间 |
| `npm run test:auth` | 认证闸、改密闸、会话 Cookie |
| `npm run test:persistence` | **落盘健壮性**：原子写（不留半截文件）、`config.json` 单一写入口（可见性和签到时间不互相覆盖）、凭据错误的永久/暂时分类 |
| `npm run test:store-usage` | SQL 聚合口径：NULL 不变成 NaN、`tokens = prompt + completion`、`GROUP BY` 归一空值 |
| `npm run test:usage` | `/api/usage` 的 14 天分桶、「今天 vs 全量/近 30 天」的边界 |
| `npm run test:usage-hourly` | 单日 24 小时：**恒 24 项**、费用按每条记录自己的时刻分峰谷、未来/非法日期抛错 |
| `npm run test:pricing` | 费用折算：缓存是 `prompt` 的**子集**（要减不能加，价差 50 倍）、峰谷按每条记录的 `ts` 分别计价、金额按量级给小数位、**按北京时间判断峰谷**（不看进程 TZ） |
| `npm run test:checkin-scheduler` | 签到调度：`transient` 错误走 10/30/60 分钟阶梯、其他错误只重试一次、**通道返回 `status: 'error'` 记录（不抛异常）也必须进阶梯** |
| `npm run test:checkin-switch` | 账号级签到开关：关掉的号不自动签、**跳过留一条 `skipped` 且每账号每天只一条**、**手动一键签到不受开关限制**、内存副本跟着变 |
| `npm run test:routes` | 账号 × 模型列表、对话两条分支、429/401 改状态且**不换号**、**`/v1/*` 只认 Bearer 不认 Cookie** |
| `npm run test:http` | 真起服务跑一遍（临时数据目录，端口 7899），页面/表单/接口边界 |

**这些测试钉的都是「不会报错、只会让数字悄悄错」的地方**：SQL 写错不报错、字段映射漏了不报错、状态机串号不报错、峰谷算错不报错。改这几块必须跑。

**别写死通道数**：`test:http` 里用注册表长度比对。它曾经写死 `3`，加 Loomy 之后一直红着——因为那套测试当时没进 `npm test`，没人看见。

### 没有测试覆盖的部分

逆向协议类的改动（上游字段映射、SSE 分帧、COSY 签名、各家的登录流程）**没有自动化测试**。
那些代码改动频率低，改的时候本来就要真机验证：

```bash
# 起网关，加一个真账号，走一次对话
docker run -d -p 7801:7801 -v cb-data:/app/data ghcr.io/wanlinus/creditbridge:latest
# 浏览器 /accounts 登录 → /keys 建 key → curl 打一次 /v1/chat/completions
```

改完必须重启网关，并验证 `/api/health`、`/v1/models`、`/api/accounts/<id>/credits`、至少一次对话（`/api/accounts/<id>/usage` 里能看到那一行、`account` 字段对得上）。

---

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| API 全回 **401** | 没带凭据，或 key 被停用/删了。程序用 `Bearer sk-…`（`POST /api/keys` 建，界面在 `/keys`），浏览器先打开 `/login`。`/api/health` 也在闸后，别当无认证探针 |
| 换了新 key 但 DSH 还是 401 | key 整串只在创建时显示一次，复制错一位就无效；重新建一把，或者先看 `/keys` 列表里那把它还在不在 |
| 有凭据仍 **403** `还没改过默认密码` | 浏览器 `/login` 登 `admin/admin` → `/password` 改密（至少 6 位、不能和旧密码相同）。改完不换 key |
| 打开页面被弹回 `/login` | Cookie 失效（12 小时）或容器重启过（会话在内存里）。重新登录。**注意这是前端跳转**：服务端对所有页面一律 200，未登录不会再 302 |
| **模型列表为空** | 先看 `/api/health` 的 `accounts`：一个账号都没有就去 `/accounts` 加。有账号但取不到目录（未登录、CLI 不在、上游拒绝）会跳过那个号，原因在 `data/logs/` |
| 404 `没有账号 wb-9` | 模型 id 里的账号不存在。去 `/accounts` 看现有账号；**网关不会退到别的号** |
| 429 `账号 wb-1 限流中，HH:MM 后可再用` | 上游限流，状态机自动进冷却，到点自动恢复。想立刻用得等或者换账号（改模型选择） |
| **今日用量一直是 0** | 先看账本里 `credit` 是不是 `0`：WorkBuddy 的 `deepseek-v4.1-flash` / `hy4free` 是**免费模型**，上游就报 0，那是准确值。若 `credit` 是 `null`、`status` 是 `499`，那是记账时机的 bug（2026-11-10 修过：取消时先记账后收尾，导致 usage 永远读不到）。**v4 起账本在 `gateway.db` 的 `usage_record` 表里**：写库失败会打日志 `usage db insert failed`，不会报给客户端 |
| 账本里 `status: 499` | 客户端主动断开（用户点停止 / 关对话 / 切模型）。**正常现象**，只要 `credit` / `promptTokens` 有值就说明用量记下来了。详见下面「499 是什么」 |
| 503 `账号 wb-1 的凭据已失效` | 上游回 401。去 `/accounts` 点「重新登录」 |
| DSH 里模型列表是旧的 / 空的 | 模型清单由插件的 host 半边同步写入 profile。看 `~/.dsh/cb-dsh/plugin-host.log`，或 `curl.exe 127.0.0.1:7802/model-sync` 看上次结果 |
| 面板一片空白、控制台 `Unexpected token '<'` | 静态资源被 SPA fallback 接走了（回的是 HTML）。查 `web/dist/assets` 是否存在、`app.ts` 里 `serveStatic` 的 `root` 对不对 |
| 容器一直 **unhealthy** | healthcheck 探 `/login`，正常一定 200；`/api/health` 在闸后回 401，不能拿它做检查。起不来多半是 `data/config.json` 的 `host` 不是 `0.0.0.0`，或 `data/` 卷权限不对（容器以 uid 1000 的 `node` 写） |
| 改了源码但容器里没变化 | 镜像没更新。等 CI 构建完，然后 `docker compose pull && docker compose up -d`。服务器上**没有源码**，`docker compose build` 在那儿跑不了 |
| 上游 `400 code 11128` | WorkBuddy 风控短语。看日志里的上游原文，把新短语加进 `src/channels/workbuddy/upstream.ts` 的 `CHANNEL_PHRASE_REWRITES`，重启网关 |
| Qoder 对话 502 | 先看日志里的上游原文。额度/签到走 `/sash/*`（`dt-` 令牌），对话走 COSY 签名的 HTTP SSE——两套都用同一份凭据，不需要 CLI。若报「凭据里缺少对话签名信息」，那是登录时 wasm 现算失败，重新登录一次即可 |
| 签到报 `code 9074 当前参与用户太多` | 上游活动侧瞬时爆满，**不是**凭据/设备号/版本号的问题，也不是我们这边能修的。调度器对这类错误按 10/30/60 分钟阶梯重试；客户端自己也重试不了（`checkin_claim` 的 `retry` 固定 0）。实测同一账号同一设备号隔 40 分钟就能领成。 |

### 499 是什么

`499` 不是 HTTP 标准码，是 nginx 的 `client closed request` 约定，网关沿用：**请求已经发到上游了，但流没读完客户端就走了**。

触发点只有一处——`routes/openai.ts` 里 SSE 流的 `cancel()`。DSH 关掉连接就会走到那里：点停止、切模型、或者它自己放弃等待。

**它不是错误**：

- 用量照样记账，`credit` / `promptTokens` 都是真实值，积分照扣；
- 页面上和 200 一样显示**绿色**——颜色在这一列回答的是「这次请求有没有出问题」，499 的答案是「没有」。理由放在悬停提示里，不占用颜色语义。（2026-11-10 先标红、后改橙，都不对：标红让人以为故障，标橙暗示要留意，而它两样都不是。）

真正该看的是 **completionTokens 和 durationMs**：正常回答是几十秒、上千 token；如果 499 密集出现、每次只有 4~6 秒、completion 只有几十到几百，那是客户端在反复重试或反复被打断，问题在客户端侧（看 DSH 日志，不在网关）。

---

## 已知限制

- **Trae 的单次消耗是算出来的**：它不回报单次积分，网关在请求结束后读账号计数器做差（等 3 秒，串行），所以账本那一行会晚几秒落盘，偶尔缺 `credit`。
- **Trae 能到 100 万上下文，前提是模型名发对**：对话请求必须在**顶层**发 `config_name` + 带变体后缀的 `model_name`（`deepseek-v4.1-flash__max`）。只发 `model` 的话服务端会忽略模型、落到账号默认模型，那时 23 万 token 就被 `4026` 拒——看起来像「上限只有 20 万」，其实是从没选到那个模型。改对之后实测：49.3 万 token 正常返回，26 万走 `/v1/chat/completions` 端到端 200。网关现在一律用 `__max` 变体发，`/v1/models` 报 `context_length: 1000000`、`max_output_tokens: 64000`，`⚙` 的档位按 50% / 75% / 100% 给。
- **Trae 的大上下文很贵**：实测约 **45 积分 / 100 万 prompt token**（1.5M token 花了 68.7 积分）。WorkBuddy 便宜一个数量级，长上下文优先走 `wb-1/*`。
- **Trae 的配置读的是 `solo_agent`，对话发的是 `chat_v3`**：两份模型表不一样（`solo_agent` 说 200000/32000，`chat_v3` 说 116000/16000），但实测两个数都不是硬闸门（26 万 token、32000 输出都被接受）。故意读更宽的那份，别"顺手统一"——按 `chat_v3` 报会让 DSH 提前压缩。
- **Qoder 的模型名单和账号无关**（`/algo/api/v2/model/list` 一份，6 小时缓存），所以 `qd-1/*` 换号不会换名单。
- **模型设置在网关，不在 DSH**：上下文窗口、最大输出、缺省思考档都存在 `data/config.json` 的 `modelSettings` 里，在 `/models` 页改。插件不再提供 ⚙ 下拉，也不再有 `127.0.0.1:7802/model-config`——它只负责把 `/api/models` 照抄进 profile。改完仍需重启 DSH（profile 只在启动时读一次）。
- **模型数量随账号数线性增长**：2 个号 = 2 套 id。加号之后 DSH 那边由插件自动同步，不用手动探测。
