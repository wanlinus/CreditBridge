# CreditBridge（积分桥）

**代理 4 个 AI 平台的积分，转成一个标准的 OpenAI 接口，供 DSH 与任何 OpenAI 客户端使用。**

对上游说四家各自的私有协议，花的是你账号里的积分；对下游说标准 OpenAI 协议——DSH、其他
agent、任何 OpenAI 兼容客户端都能直接接过来用，无需为每个平台单独写适配。

仓库里两个子项目：

| 目录 | 是什么 |
|---|---|
| `cb-gateway/` | **网关本体**。TypeScript、无构建步骤，`node src/index.ts` 直接跑。对外是 OpenAI 兼容接口（`/v1/*`），对内翻译成四家上游的私有协议，按「通道 + 账号」路由。 |
| `cb-dsh/` | **DSH 插件，可选**。只做两件事：把网关地址和 API key 写进 DSH 配置（用户填一次）；在输入框右侧显示余额徽标。用别的 agent 时不需要它，把 base URL 指向网关即可。 |

账号、余额、签到、模型可见性全部在网关的网页上管理，插件不重复实现一份。

---

## 四个通道

| 通道 | id | 前缀 | 上游 | 模型来源 |
|---|---|---|---|---|
| WorkBuddy | `workbuddy` | `wb` | `copilot.tencent.com` | 上游 `/v3/config` 实时目录 |
| Trae CN | `trae` | `tr` | `trae-api-cn.mchost.guru` | 服务端配置 `batch_get_detail_param` |
| Qoder | `qoder` | `qd` | 本地 CLI 子进程 + `gateway.qoder.com.cn` | CLI `--list-models` |
| Loomy | `loomy` | `lo` | `loomyad.xunfei.cn` | 上游 `/api/v1/models` |

通道不是路由前缀，而是**模型 id 的前半段**。一个通道挂 N 个账号，每个账号一套 id：

```
wb-1/hy4free      →  WorkBuddy 通道、1 号账号、hy4free 模型
wb-2/hy4free      →  同一个模型，但花 2 号账号的额度
tr-1/glm-5.3      →  Trae 通道、1 号账号
qd-1/auto         →  Qoder（只能挂一个号，见下）
```

**Qoder 只能挂一个账号**：它的对话走常驻 CLI 子进程，登录态是机器级的一份，不是「一个号一套
凭据」。多挂一个号会让人以为 `qd-2` 花的是 2 号的钱，所以账号层直接拦住。

---

## 架构

```
DSH / 任意 OpenAI 客户端
        │  Authorization: Bearer sk-…（OpenAI 兼容 /v1/*）
        ▼
cb-gateway（node src/index.ts，默认 127.0.0.1:7801）
   ├─ /v1/models              账号 × 模型，每个账号一套 id
   ├─ /v1/chat/completions    按模型 id 找通道 + 账号 → 转发上游 → SSE
   ├─ /api/*                  管理 API（账号、余额、签到、key、可见性）
   └─ 其余路径                前端 SPA（Vue 3），公开静态文件
        │
        ├─ WorkBuddy  copilot.tencent.com
        ├─ Trae CN    trae-api-cn.mchost.guru
        ├─ Qoder      本地 CLI 子进程 + gateway.qoder.com.cn
        └─ Loomy      loomyad.xunfei.cn
```

数据落 `cb-gateway/data/`：凭据、账号、签到记录、用量账本、日志。**这个目录里有明文 token，
不要提交、不要外发。**

---

## 运行要求

- **Node.js 22.18 或更高**。网关直接运行 `.ts` 源码，依赖 Node 原生剥离类型，没有编译步骤。
- 网关运行时依赖只有两个：`hono` 与 `@hono/node-server`。
- 网页管理台是 Vue 3 SPA，**产物不在仓库里**（`web/dist` 被 git 忽略）。跑管理台前要先构建一次：
  `cd cb-gateway/web && pnpm install && pnpm build`（或 `npm run build:web`）。不构建也能起网关、
  走 `/v1/*` 和 `/api/*`，但打开网页会看到「前端还没构建」的提示。

---

## 快速开始

### 1. 起网关

```bash
cd cb-gateway
npm install
node src/index.ts        # 默认监听 127.0.0.1:7801
```

可选：先构建网页管理台（`cd cb-gateway/web && pnpm install && pnpm build`），否则网页打不开、
只能用 API。

### 2. 改掉默认密码

浏览器打开 `http://127.0.0.1:7801/login`，用 **`admin` / `admin`** 登录，按提示到 `/password`
改密。**改密之前，除登录页与改密页外一律拒绝访问。**

### 3. 建一把 API key

在 `/keys` 页新建。整串 `sk-…` 只显示一次，记下来（列表里也能回看原文）。客户端（DSH、脚本）
调用 `/v1/*` 与 `/api/*` 时带 `Authorization: Bearer sk-…`。

### 4. 加账号

在 `/accounts` 页选一个通道 → 「开始登录」→ 在浏览器里完成授权。每个上游的号登一次，就多
一套模型 id。

### 5. 客户端接进来

- 任意 OpenAI 兼容客户端：把 base URL 指向 `http://127.0.0.1:7801/v1`，key 填第 3 步的 `sk-…`。
- DSH：装 `cb-dsh` 插件，在「积分桥」面板里填网关地址 + key，保存后模型自动出现。

---

## 账号

**一个账号 = 一个上游的号**，落在 `data/accounts/<通道>/<id>.json`，一账号一文件。序号只增不减：
删掉 `wb-2` 不会让 `wb-3` 变成 `wb-2`，否则账本和客户端里存的模型 id 全部指向错的账号。

每个账号有四种状态，自动切换：

| 状态 | 什么情况 | 请求时 |
|---|---|---|
| `ready` | 正常 | 放行 |
| `cooldown` | 上游回 429（限流） | 429，提示几点后可再用，到点自动回 ready |
| `invalid` | 上游回 401（凭据坏了） | 503，提示去管理台重新登录 |
| `disabled` | 在管理台手动停用 | 503 |

429 只封那个模型、不封账号（WorkBuddy 的限流是按模型的）：同账号下别的模型照常能用。

### Trae 登录（跨机部署下最容易踩坑）

Trae 的登录要把浏览器重定向回网关，而浏览器在你的机器上、网关在容器里，所以容器必须发布一个
回调端口，并告诉网关「对外地址是什么」。回调地址**必须写成环回**（`127.0.0.1`）——Trae 的授权页
只肯把浏览器跳回环回地址，填内网 IP 时它不发请求。

插件会替你做本机转发：网关在登录开始的瞬间通过 `/api/events`（SSE）推一条事件，插件的 host
半边就在本机开一条 TCP 转发 `127.0.0.1:<port>` → `<网关 host>:<port>`，登录结束自动关。插件没跑
时可以手动开隧道兜底：

```bash
ssh -N -L 18801:127.0.0.1:18801 <网关宿主机>
```

---

## 认证

两类凭据，**互相独立**——改密码不影响 key，吊销 key 也不影响浏览器登录：

| 调用方 | 凭据 | 说明 |
|---|---|---|
| 浏览器 | 会话 Cookie | `POST /api/login` 后种下，12 小时，存内存 |
| 程序（DSH、脚本） | `Authorization: Bearer sk-…` | `/keys` 页新建，明文可回看 |

- `/v1/*` **只认 Bearer key，不认 Cookie**——那是程序协议入口，凭据要能单独吊销。
- 会话存内存里：容器重启后浏览器要重新登录，但上游账号凭据和 API key 都在 `data/` 里，不受影响。

---

## 路径分三层

| 层 | 前缀 | 认证 | 返回 |
|---|---|---|---|
| 前端 SPA | 其余一切（`/`、`/accounts`、`/keys`、`/models`、`/checkin`、`/settings`、`/login`、`/password`、`/assets/*`） | 不需要（公开静态文件） | HTML / JS / CSS |
| 管理 API | `/api/*` | Bearer key 或 Cookie | JSON / SSE |
| OpenAI 兼容 | `/v1/*` | 只认 Bearer key | JSON / SSE |

### OpenAI 兼容（对外主入口）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/models` | 账号 × 模型，每个账号一套 id |
| POST | `/v1/chat/completions` | 按模型 id 找通道 + 账号 → 转发上游 |

### 管理 API 摘要

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 只读本地状态：账号数组 + 通道元数据（要认证） |
| GET | `/api/channels` | 通道外观：label + letter + icon（data URI） |
| GET | `/api/models` | 同 `/v1/models`，逐字节相同 |
| GET/POST | `/api/models/visibility` | 模型可见性配置（总闸 + 逐模型勾选） |
| POST | `/api/login` / `/api/logout` / `/api/password` | 浏览器会话登录 / 登出 / 改密 |
| GET | `/api/accounts` | 账号列表 + 余额 + 今日消耗 + 通道能力位 |
| GET/PATCH/DELETE | `/api/accounts/:id` | 单账号详情 / 改 label 或停用 / 删除 |
| POST | `/api/accounts/:id/verify` | 真打一次上游验凭据 |
| POST | `/api/accounts/:id/logout` | 让上游注销会话（账号保留） |
| POST | `/api/accounts/:channel/login` | 起一次登录任务 |
| GET | `/api/accounts/:id/credits` | 单账号余额完整快照 |
| GET | `/api/accounts/:id/usage` | 单账号账本（token / 积分 / 按模型 / 按天） |
| GET/POST | `/api/accounts/:id/checkin` | 签到状态 / 手动领取 |
| POST | `/api/checkin/all` | 一键签到所有 ready 账号 |
| GET/POST/DELETE | `/api/keys` | API key 管理 |
| GET | `/api/events` | SSE 事件流（登录开始时推 `login` 事件，插件据此开转发） |
| POST | `/api/shutdown` | 关闭网关进程 |

错误信封统一为 `{ "error": { "message": "人话原因", "type": "…", "code": "…" } }`。

---

## 模型可见性

`/models` 页提供两级筛子：通道总闸（关掉后这个通道的模型整体不出现在 `/v1/models`）+ 逐模型
勾选。只影响列表输出，**不影响对话**——被隐藏的模型仍可直接调用。改完立刻生效，不用重启。

---

## 签到

网关每天按 `checkinTime`（默认 `10:05`，可在 `/settings` 改）自动给所有 `ready` 账号签一次，
失败按 10 / 30 / 60 分钟阶梯重试。签到日志和「一键签到」在 `/checkin` 页。

---

## 数据与文件

```
cb-gateway/data/
├─ config.json               host / port / checkinTime / 可见性
├─ usage.jsonl               账本，只追加（每行一次请求：token、积分、状态、耗时）
├─ auth/gateway.json         网页账号（scrypt 哈希）
├─ auth/keys.json            API key 表
├─ accounts/<通道>/<id>.json  上游账号（凭据 + 状态）
├─ state/checkin/            签到记录
├─ state/checkin-log.jsonl   签到历史
├─ state/model-cooldown.json  模型级冷却
├─ cli/qoder/                Qoder CLI（首次登录时自动下载）
└─ logs/                     按天日志
```

`data/` 已 gitignore。**里面有明文 token，不得提交。**

---

## 测试

```bash
cd cb-gateway
npm run check      # tsc --noEmit，0 error 才算过
npm test           # 全部测试套件，不需要网关、不需要真上游
```

网关测试覆盖：账号存储与状态机、落盘原子性、模型 id 拆解、认证闸、可见性、签到调度、
各通道的凭据/目录/签名解析、账本聚合、DeepSeek 费用折算（峰谷计价）等。

插件测试（`cd cb-dsh && npm test`）覆盖：profile 写入、凭据引用、上下文窗口下拉、徽标渲染、
环回转发隧道、SSE 客户端、未配置分支。

---

## 排错

| 症状 | 先看 |
|---|---|
| API 全回 401 | 没带凭据，或 key 被停用/删了。程序用 `Bearer sk-…`，浏览器先打开 `/login` |
| 有凭据仍 403「还没改过默认密码」 | 浏览器 `/login` 登 `admin/admin` → `/password` 改密 |
| 模型列表为空 | `/api/health` 的 `accounts` 里一个号都没有 → 去 `/accounts` 加；有号但取不到目录看 `data/logs/` |
| 404「没有账号 wb-9」 | 模型 id 里的账号不存在，网关不会退到别的号 |
| 429「账号限流中」 | 上游限流，自动冷却、到点恢复；换个账号的模型 |
| 503「凭据已失效」 | 上游回 401，去 `/accounts` 点「重新登录」 |
| 打开网页是「前端还没构建」 | 没跑 `pnpm --dir cb-gateway/web build`，构建一次即可 |

---

## 已知限制

- **私有接口，随时可能变**。四个通道走的都是客户端私有协议，上游改版、加风控不提前通知。
- **TLS 指纹对不上**：网关是 Node 的 TLS 栈，客户端是 Chromium 的 BoringSSL。目前上游没查这个。
- **模型数量随账号数线性增长**：2 个号 = 2 套 id。要压数量去 `/models` 关掉或勾选。
- **Trae 的单次积分是算出来的**：它不回报单次积分，网关在请求结束后读账号计数器做差，账本
  那一行会晚几秒落盘，偶尔缺积分。
- **上下文窗口是单值**：DSH 的模型条目 schema 没有档位列表，只能填一个数值。

---

## 免责声明

`copilot.tencent.com`、`trae-api-cn.mchost.guru`、`gateway.qoder.com.cn`、`loomyad.xunfei.cn`
都是对应桌面客户端的**私有接口**，不是官方开放 API。

是否违反各自的服务条款请自行判断；账号被限制、额度被清空的风险由使用者自担。本项目与上述
厂商没有任何关系，也未获得其授权或认可。请只用于你本人有权使用的账号。

## v3 相对 v2 的更新

v3 把管理界面从「服务端渲染的模板页」彻底换成「Vue 3 单页应用」，并把用量统计的主口径
从积分改成 token。

### 界面：SSR 模板 → Vue 3 SPA

- 删掉整套服务端渲染界面（8 个 SSR 页面 + 17 条表单 POST），前端改成 Vue 3 + Vite + ECharts
  的 SPA，同源托管，服务端不再出任何 HTML 页面。
- 七个页面：概览、账号、账号详情（一页三 tab：概览 / 用量 / 模型）、密钥、模型可见性、
  签到、设置；另有登录页与强制改密页。
- 概览页重新设计：六张指标卡（积分总量 / 已用积分 / 已用 Token / 折合 DS 费用 / 缓存命中 /
  请求健康）+ 近 14 天消耗堆叠图（通道 / 模型 / 账号三种口径，总 Token / 仅输出两档）+
  左右两栏账号表 + 最近请求列表。

### 用量统计：token 为主口径

- **token 是上游报的数，网关不自己数**：`data/usage.jsonl` 里的 token 全部来自上游响应的
  `usage` 帧，网关只记账和汇总。各家的 tokenizer 不同，自己数出来的数字和账单对不上。
- **积分则相反**：它只读官方余额，不做逐请求结算。Trae 那套「请求前后对计数器做差」已删除。
- 概览页的「积分总量」= 所有账号剩余积分合计（含 Loomy）；「已用积分」= 上游报的已用值。

### 折合费用（新）

- 新增「折合 DS 费用」卡片：按 DeepSeek 官方价目（元 / 百万 token）把 token 折算成人民币
  参照值，区分高峰 / 空闲时段计价（高峰 = 北京时间工作日 9:00–12:00、14:00–18:00）。

### 修复

- **Qoder 签到三天一次都没领到**：签到窗口每天北京时间 10:00 才开，默认签到时间从 09:00
  改成 10:05。
- **Trae 签到报 9074**：`x-app-version` 从写死的 3.3.104 改成通道自述的 `appVersion`。
- **Loomy 的积分消耗从来没进过账本**：上游字段名没对上，修正后 `points_consumed` → credit。
- **Loomy 的可用积分少显示四成**：只读 `balance` 会漏掉每日额度，改成三层回退。
- **SPA 壳缓存**：壳（`index.html`）必须 `no-cache`，否则升级后浏览器还是旧界面。

## 许可

MIT，见 [LICENSE](LICENSE)。
