# CreditBridge 项目约定

本仓库两个子项目：`cb-gateway/`（本机 OpenAI 兼容网关）、`cb-dsh/`（DSH 插件，侧边栏「积分桥」面板）。

## 语言与注释

- **代码注释一律写简体中文**。代码、命令、路径、标识符、协议字段名（如 `x-device-id`、`checkin_credits/claim`）、URL、日志原文保持原样，不翻译。
- **仓库里所有文档一律用简体中文**：`README.md`、`ARCHITECTURE.md`、`private/docs/` 下的一切、各子目录的 `README.md`，新建文档也一样。代码块、命令、字段名、URL 保持原样；引用官方原文时保留英文原句，再用中文说明。
- 注释写「为什么」、取舍和踩过的坑，不要复述代码字面意思。

## 文档在哪

改代码前先看对应的那份；**加了、删了、改了文档，回头把这张表更新掉**（表过期比没表更坏）。

**`private/` 不进公开仓库**（`.gitignore` 里有一条）：逆向记录、协议分析、内部重构方案、
逆向探针工具都放那里，跟着代码在同一个工作目录、随时能查，但不会随仓库发布。
源码注释里写 `private/docs/xxx.md` 的引用指向它。

| 文件 | 是什么 | 什么时候读 |
|---|---|---|
| [`README.md`](README.md) | **用户手册**：怎么装、怎么用、排错 | 第一次用 |
| `AGENTS.md` | 本文件：改代码前的约定 | 动手改代码前 |
| [`cb-gateway/README.md`](cb-gateway/README.md) | 网关：起服务、认证、路由清单、排错 | 部署、运维、排查 |
| [`cb-gateway/ARCHITECTURE.md`](cb-gateway/ARCHITECTURE.md) | 网关内部：组件、数据流五条链路、`Channel` 契约、不变量 | 改网关代码前 |
| [`cb-gateway/API.md`](cb-gateway/API.md) | 每条路径的请求/响应形状、SSE 帧序列 | 调接口、改响应形状 |
| [`cb-dsh/README.md`](cb-dsh/README.md) | 插件：配置向导、登录回调转发、模型同步 | 改插件 |

**`private/` 里有更多**（不发布，`.gitignore` 挡掉）：v2/v3/v4 重构方案、各通道逆向记录、
加通道清单、逆向探针工具。源码注释里 `private/docs/xxx.md` 的引用指向它。
其中几份在动相关代码前值得翻：

| 文件 | 什么时候读 |
|---|---|
| `private/docs/adding-a-channel.md` | 新增通道 |
| `private/docs/v2/README.md` | 动架构（账号池、多 key、模型 id 的由来） |
| `private/docs/v3/overview-redesign.md` | 改概览页 / 用量统计 / 费用折算 |
| `private/docs/v4/README.md` | 动 `data/` 落盘、加持久化模块 |
| `private/docs/*-recon.md` | 改对应通道的协议、核对上游数值 |

`private/docs/qoder-*.md` 是**历史事实记录**，按当时的事实读，不要按新架构「修正」里面的结论；勘误只加在 `qoder-open-questions.md` 末尾。

写文档的三条硬要求：路径 / 命令 / 配置键在代码里出现，就必须在这套文档里对得上；同一个事实只写一处，别处引用；不要写「旧路径搬到新路径」的迁移说明（见「数据不做迁移」）。

## 编辑含中文的文件

- 只能用 **edit 工具或 Node 脚本**改写。**禁止** PowerShell 的 `Get-Content | Set-Content`、`Out-File`——它按 ANSI(GBK) 解码 UTF-8，会静默写坏中文（本仓库已踩过：整段中文变 `绉垎鍖?`，只能 `git checkout` 恢复）。
- 保存为 **UTF-8 无 BOM**。

## 架构原则：通道自述，界面只认清单

**加一个通道只应该改两处**：新建 `src/channels/<name>/`，再在 `src/channels/index.ts` 加一行。
如果发现还要动 `app.ts`、`routes/*`、`web/src/`、`lib/client.js`，那说明有硬编码漏在编排层或界面里——先把它拆掉，再继续加通道。

- **元数据只有一份**：`id` / `idPrefix` / `label` / `identity` 在通道对象上声明（`defineChannel` 校验），别处一律读出来，不许再抄一遍。`idPrefix` 是**模型 id 的前半段**（`wb` → `wb-1/hy4free`），必须全小写字母数字、全局唯一——撞车不会报错，只会让一批请求静默走错上游，所以注册表加载时拦。
- **没有通道前缀路由**（v2）：`/workbuddy/v1/models` 那套已经删掉，只剩 `/v1/*` 一个入口。通道只作为模型 id 的前半段存在，拆不出「短前缀-账号」就 404，不猜。
- **版本号属于通道，不属于全局配置**：报给上游的客户端版本串写在通道的 `identity` 里（`clientVersion` / `channelVersion` / `ideVersion`），`/api/health` 会原样回出来。上游常拿版本号当「客户端够不够新」的门禁，而且**报错文案会骗人**——2026-11 Trae 的版本串写死在 `auth.ts` 里停在 `3.4.15`（客户端早已 `1.107.1`），换令牌回的是 `401 20405 Device proof required`，看起来像签名问题，实际是版本太旧。写死的东西会烂，所以把它做成必填项：漏了类型检查就报错。
- **能力也是自述**：`login` / `probe` / `logoutOf` / `catalogOf` / `checkinStatusOf` 有没有实现，路由层用 `typeof channel.x === 'function'` 判断；界面读 `/api/accounts/<id>/credits` 返回的 `canLogin` / `canLogout`、`/api/health` 的 `multiAccount`，不自己判断。`multiAccount: false` 表示这个通道只能挂一个号，账号层会拦住第二个（目前四个通道都允许挂多个）。
  **`typeof` 只许写在 `core/channel-info.ts` 的 `capabilitiesOf()` 里**——三个响应（`/api/accounts` 的 `channels[]`、`/api/health` 的 `channels{}`、`/api/accounts/:id` 的 `channel`）都从它取。2026-11-22 之前这段在三处各抄了一遍，代价是**加第五个能力位时必然漏一处**，而漏掉的表现是「那个按钮永远不显示」，三个响应看起来都对、类型也都过。
  同一个文件里的 `primaryAccountOf()` 是「拿这个通道的哪个号去问上游」的唯一实现（优先 `ready`，其次第一个，都没有是 `null`）——`/api/models/catalog` 和 `POST /api/models/settings` 共用它，两处各写一遍会导致「目录页能列模型、设置页存不进去」这种半坏状态。
- **界面不认具体通道**：禁止出现 `["workbuddy", "trae"]` 这类清单、按通道分支的地址、内置的 `PROVIDERS` 对照表。地址用 `/api/health` 带回来的 `idPrefix` / 账号 id 拼。
- **「这个模型是不是网关的」只能看模型 id**：v2 的 profile 里只有一个网关 provider（DSH 叫它 `jf` / `qb`），它底下挂着四家通道所有账号的所有模型。所以判据是**模型 id 的前半段账号 id 在不在 `/api/health` 的 `accounts` 里**——拿 DSH 的 `provider` 路由名去比通道清单永远不相等（2026-11-10 就是这么坏的，徽标一个都不显示）。
- **该暴露就暴露在这四处**：`GET /api/health` 的 `accounts` 数组 + `channels[id]`（`idPrefix` / `identity` / `listed` / `multiAccount`）、`GET /api/channels` 的**外观**（`label` / `letter` / `icon`）、`GET /api/accounts/<id>/credits` 的 `label` / `account` / `canLogin` / `canLogout`、`GET /api/accounts` 的账号列表。界面需要新字段就加在这些响应里，不要在 UI 侧补一份索引。
- **图标属于通道，而且在网关**：品牌图标是 `channels/<name>/icon.png`（64×64 PNG、四角透明、和现有几张风格一致），由 `core/channel-icons.ts` 读成 data URI、`GET /api/channels` 回给界面；缺图时用 `letter` 兜底。**不要在前端内联 base64**——2026-11 Loomy 上线后徽标一直没有图标，就是因为插件里那张内联表少了一行，而注释还写着「缺了会退回名字首字母」（那段兜底根本不存在，实际是静默留白）。
- **徽标上显示什么由网关算**：`core/badge.ts` 的 `amount` / `today`。显示积分还是 token 是通道计费语义（免费模型上游就报 `credit: 0`），别把这类规则写回前端——那样每加一个计费方式不同的通道都要改插件。
- **token 是上游报的数，网关不自己数**：账本（`usage_record` 表）里的 `promptTokens` / `completionTokens` 全部来自上游响应的 `usage` 帧，网关只记账和汇总。各家的 tokenizer 不同，自己数出来的数字和账单对不上，显示它没有意义。**积分则相反**：它只读官方余额（`creditsOf()`），不做逐请求结算——Trae 那套「请求前后对计数器做差」已于 2026-11-13 删除。
- **没有「按通道的文案表」**：v2 的 `ui/account-detail.ts` 里有一份各通道能力说明，随旧 UI 一起删了（2026-11-13）。界面需要通道相关文案时，加在 `/api/*` 的响应里，别在前端按通道分支。

自查：加完通道后 `grep -n '"<新通道 id>"' cb-gateway/src cb-dsh/lib`，命中的只应是 `channels/<name>/` 和 `channels/index.ts`。2026-11 那次 `4198471` 就是把这批硬编码清掉的：面板、网关网页、徽标原先各自抄了一份通道表。

**账号不是通道的一部分**：通道不知道「自己挂了几个号」，凭据由 `Account` 对象传进来。所以加通道不用管账号，加账号也不用改通道。这条是 v2 的核心，别为了省事把账号循环写进通道里。

## 数据不做迁移

**这个项目不写数据迁移代码，也不要为旧路径加兼容分支。**

`data/` 的布局（`config.json` / `gateway.db` 留在根，其余按 `auth/` `state/` `logs/` 分类，见 `src/shared/paths.ts`）就是唯一事实。改布局时：

- **改代码 + 改文档，就结束**。不要写「旧文件搬到新位置」的表或幂等搬运，也不要写「新位置没有就读旧位置」的兜底。
- 旧文件留给使用者自己删。`data/` 里没有任何不可再生的东西：凭据点一次「登录」就回来，签到记录丢一天、账本只是统计、模型目录缓存是一次 HTTP 请求。
- 需要清场就直接删文件或整个 `data/`；各模块写盘前都会自己 `mkdirSync`，删空目录不会导致启动失败。

理由是收益和风险倒挂：为一个单机单用户工具的本地状态写迁移，能省下的只是点一次登录；代价是多一条**静默失败**的路径——搬错了没人知道，因为读的地方和写的地方都「成功」了。2026-11 就踩过：`catalog.json` 被搬成 `trae-catalog.json`，实际是 WorkBuddy 的目录缓存，没有任何代码读它，直到几周后整理 `data/` 才发现。

配套的产出是：**路径出现在代码里的地方必须和文档、`README` 的目录树一致**。改路径要一次改全（`paths.ts` + 各模块 + 文档），漏了会立刻表现为「未登录」或「读不到状态」，这是能当场看见的失败，比迁移表那种延迟失败好。

## cb-gateway

- 源码是 **TypeScript，无构建步骤**：`node src/index.ts` 直接跑（Node 22.18+ 原生剥离类型）。`.ts` 即产物，改完重启进程即可。
- **不能写** `enum` / `namespace` / 构造器参数属性 / 装饰器——剥离器做不了，会直接 `SyntaxError`。
- 类型检查：`npm run check`（`tsc --noEmit`），**0 error 才算过**。
- **`npm test` 必须过（47 套全跑，一条命令）**。改代码前先认领自己会碰到哪几套：
  改哪一块就跑哪几套（`npm test` 一条命令全跑，这里只是「改完先自查」的对照）：

  | 改什么 | 跑什么 |
  |---|---|
  | 通道协议（`channels/*/upstream.ts`、`*/auth.ts` 的解析） | `test:callback` `test:credential` `test:trae-config` `test:trae-usage-cache` `test:loomy-credit` `test:catalog` `test:qoder`，外加 `test/loomy-sign.mjs`（无别名） |
  | 余额读取的错误处理（任何 `creditsOf`） | `test:workbuddy-usage` |
  | 账号维度（状态机、序号、凭据刷新） | `test:accounts` `test:persistence` |
  | Trae 设备号 | `test:trae-device` |
  | 签到领取 / 调度 | `test:trae-checkin` `test:checkin-scheduler`，外加 `test/qoder-checkin.mjs`（无别名） |
  | 签到开关 | `test:checkin-switch` |
  | 模型 id 拼拆 / 可见性 | `test:router` `test:visibility` |
  | Qoder 上下文窗口 / prompt 限长 | `test:qoder-prompt-limit` `test:qoder-window` |
  | Qoder COSY 签名 | `test:qoder-cosy`（联网版 `test:qoder-cosy-live` 不进 `npm test`，花积分） |
  | Qoder SSE / 用量提取 | `test:qoder-sse` |
  | Qoder 多账号 / 客户端断开 | `test:qoder-multi-account` `test:qoder-abort` |
  | 落盘（原子写、config.json） | `test:persistence` |
  | SQL / 账本聚合 | `test:store-usage` `test:usage` `test:usage-hourly` |
  | 认证 / 路由边界 | `test:auth` `test:routes` |
  | 余额读取（刷新积分） | `test/credits-refresh.mjs`（无别名） |
  | 前端页面 | `npm run check:web` + `test:http` |
  | 费用折算 | `test:pricing` |

  说明：表格里写 `test/xxx.mjs` 的那几个**没有 `npm run` 别名**，但**在 `npm test` 链里**，
  改了照样会被跑到；想单独跑就 `node test/xxx.mjs`。

  **几条最容易踩的**（细节在各自测试文件的头注释里）：
  - `test:trae-usage-cache` 钉字段映射：上游的 `cache_read_input_tokens` 不映射成
    `cached_tokens`，DSH 的「缓存命中」恒为 0 且不报错
  - `test:workbuddy-usage` 钉「5xx / 业务码非 0 / 非 JSON 必须抛错」——不抛的话
    `totalRemain` 变 0，而 **0 是合法数字**，界面显示「剩余 0」像是额度用光了
  - `test:checkin-scheduler` 钉「通道返回 `status: 'error'` 记录（不抛异常）也必须进重试阶梯」
    ——三个通道都是返回记录而不是抛错，只测「假通道抛异常」会漏掉整条路径
  - `test:qoder-cosy` 钉三件事：`Cosy-Key` 是原样透传不是算的、`.auth/user` 的解密密钥是
    `machine_id` 前 16 字符、**wasm 只能执行一次**（两次会句柄串号）
  - `test:qoder-sse` 钉「外层 200 + 内层 403」这种帧形态——只看 HTTP 状态码会误判成功

- `test/e2e-http.mjs` **不写死通道数**：加通道时用注册表长度比对。它曾经写死 `3`，加 Loomy 之后一直红着没人发现——因为它当时没进 `npm test`。
- `npm test` 里含 `smoke:chat`（没有 `QB_API_KEY` 时自动跳过、exit 0）；不在 `npm test` 里的是两套：`smoke:tools`（要网关真的在 7801 上跑）与 `test:qoder-refresh`（**会真打上游、并把续期结果写回真实账号文件**，直接 `node` 跑会自己跳过，要显式 `--live`，`npm run` 那条已带上）。
- 加通道 = 在 `src/channels/<name>/` 实现 `Channel` 契约（见 `src/types.ts`）+ 在 `src/channels/index.ts` 登记一行。**不要改 `app.ts` / `routes/*`**。
- `data/` 里有明文 token、密钥缓存和账本，已 gitignore，**不得提交**。
- **所有 API 都要登录**（2026-11 起）。两类凭据，**互相独立**：
  - 浏览器：会话 Cookie（`POST /api/login` 后由网关种下，12 小时，存内存）
  - 程序（DSH、脚本）：`Authorization: Bearer sk-…`（在 `/keys` 页建，存明文 secret 以便回看，另留 scrypt 哈希兼容老记录）
  默认账号 `admin/admin`，**改密之前除 `/api/login` `/api/logout` `/api/password` 外一律 403**（一律 JSON）。改密码不换 key，所以 profile 不用跟着改。
  **前端产物不受闸门管辖**：`/`、`/login`、`/assets/*` 是公开的静态文件——登录页必须先能加载，
  否则就是「想进门先给我门钥匙」。数据全在 `/api/*` 与 `/v1/*` 后面。
  **`/v1/*` 只认 Bearer，不认 Cookie**（`bearerOnlyGate`）。那是程序协议入口，凭据要能单独吊销；往那里加管理端点会同时破坏这条边界。
- **Basic 认证和 v1 的明文 token 都已删除**（E 阶段）：机器凭据只有 `api_key` 表，
  不要再写回「每次请求带密码」或「从 gateway.json 读 token」那种路子，也不为它们加兼容分支。
- **路径分三层，改代码前先认清自己在哪层**：管理 API（`/api/*`，两种凭据，JSON）· OpenAI 兼容（`/v1/*`，只认 Bearer key）· 前端 SPA（其余一切，公开静态文件）。旧的「页面层 + 页面动作层」已删（2026-11-13）。分层表和每条规矩见 `cb-gateway/ARCHITECTURE.md` §六；`/v1/*` 里除了 `models` 和 `chat/completions` 不许放别的。
- **读请求体只走 `shared/json-body.ts` 的 `readJsonBody()`**：7 个写端点原先各写一遍 `JSON.parse(await c.req.text())`，而**行为不一致**——`POST /api/keys` 那处坏 JSON 静默当 `{}`，于是半截 JSON 会成功建出一把名叫「未命名」的 key。现在统一：坏 JSON 一律 400，空 body 当 `{}`。它只返回 `{ok, body}` 或 `{ok:false, message}`，**错误信封由各路由自己拼**（`/api/*` 用 `bad_request`，`/v1/*` 用 `gateway_error`，因为 DSH 那侧按 OpenAI 形状解析）。
- 改完必须重启网关，并验证 `/api/health`、`/v1/models`、`/api/accounts/<id>/credits`、至少一次对话（`/api/accounts/<id>/usage` 里能看到那一行、`account` 字段对得上）。
- **部署到 192.168.1.100**：在仓库根跑 `.\cb-gateway\scripts\deploy.ps1`（本地构建镜像 → save/gzip → scp → 远端 load + `compose up -d --force-recreate`）。**服务器上只有 `compose.yaml` 和 `data/`，没有源码**，所以在服务器上 `docker compose build` 会失败——改代码只能改开发机再重新部署。前端产物要在部署前 `npm run build:web`。
- 本地跑：`POST /api/shutdown` 停掉，再用 DSH runtime 的 node 起 `src/index.ts`。插件**不提供启停开关**（它只会拉起本地的第二份网关），只负责记住网关地址（见 `cb-dsh` 一节）。

## 平台坑（Windows）

- **网关不打开浏览器。** 它是无头服务：部署到容器/服务器时那台机器没有浏览器，而有浏览器的那台通常是用户自己的。登录流程只把地址交出去（`onUrl` 回调 + 控制台），由调用方打开（面板造 `<a target="_blank">` 交给系统浏览器）。2026-11 之前 `openBrowser()` 在网关里用 `cmd /c start` / `xdg-open` 拉浏览器，容器里 `spawn xdg-open ENOENT` 的未捕获 `'error'` 直接把进程打崩——这就是整个模块被删掉的原因。
  - 历史坑（如果以后又有代码要开浏览器）：`cmd /c start "" <url>` 里未加引号的 `&` 会被当成命令分隔符；`start` 的第一个带引号参数是窗口标题，而空字符串在 `windowsVerbatimArguments` 下会消失。
- **`git commit -m "..."` 里的 `&` 同样会被 PowerShell 截断**，提交信息里含 `&`、引号或多行时写成文件用 `git commit -F`。
- **禁止 `Get-Process chrome | Stop-Process`**（以及任何按进程名杀 `chrome.exe` 的写法）。那条命令会把**用户正在用的浏览器**一起关掉，而且强制结束不留崩溃转储、不写 Application Error——表现就是"Chrome 无缘无故崩了"，能白查两轮。2026-11-13 就是这么把两次"崩溃"归因到图表代码上的。
  - 无头 Chrome 一律带**专用** `--user-data-dir`（放 `%TEMP%\cb-headless-*`）启动，收尾只杀匹配这个目录的进程：
    ```powershell
    Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
      Where-Object { $_.CommandLine -like "*$env:TEMP\cb-headless*" } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    ```
  - 判断"是不是真的崩了"看这三处，别靠感觉：`%LOCALAPPDATA%\Google\Chrome\User Data\Crashpad\reports\*.dmp` 有没有新文件、事件查看器 `Application` 里 `Id 1000/1001`（`Application Error`）有没有 `chrome.exe`、`System` 日志里有没有 `Resource-Exhaustion-Detector` 的 2004（内存耗尽杀进程）。三处都没有 = 多半是被别的程序杀的或自己退出，不是崩溃。

## cb-dsh

**插件有两个职责**：① 把「网关在哪、用什么 key」写进 DSH 配置（面板是网关地址 + API key 两个输入框加一个「保存」，点保存 = 存配置 → 写 profile 的 provider → 拉 `/api/models` 写 `models:` 段）；② 给「必须走环回」的登录回调开一条本机 TCP 转发（`lib/events-client.js` 订阅网关 `GET /api/events`，`lib/tunnel.js` 收到 `login running` 事件就开 `127.0.0.1:<port>` → 网关的转发）。账号、余额明细、签到、可见性**全在网关网页**，别再往面板里搬。

- `lib/client.js` 按文件 mtime **热重载**；`lib/index.js`（host 半边）改动**必须重启 DSH**。
- 改完要同步到 `~/.dsh/profiles/desktop/node_modules/cb-dsh/`，否则运行中的 DSH 加载的还是旧副本（用哈希比对确认一致）。
- **模型清单由 host 半边自动写进 profile**：`lib/profile-models.js` 每 15 秒拉一次 `GET /api/models`（**唯一入口**），和 profile 里的 `models:` 段逐字节比，不一样才写（写前备份 `cordis.patch.yml.bak-model-sync-<ISO>`）。**只碰那一个 provider**：`baseURL` 的路径正好是 `/v1` 的那段，不能用 `endsWith('/v1')` 判——`/workbuddy/v1` 也满足，那是 v1 的旧条目。只碰 `models:` 段、未知字段逐行保留，不做 YAML 往返序列化。手动触发 `POST 127.0.0.1:7802/model-sync`。
- **认证只认 `apiToken`（`Authorization: Bearer sk-…`）**。`lib/index.js` 的 `gatewayAuthHeader()` 只回 Bearer，没有 Basic 分支——网关那边根本不存在 Basic 了，加回去只会让人以为「填密码也能用」然后一直 401。
- **`npm test` 必须过**（七套）：`profile-models` / `write-provider` / `setup` / `badge-strip` / `tunnel` / `events-client` / `not-configured`。改 `profile-models.js`、`writeProvider()`、`tunnel.js`、`events-client.js` 就跑。
- 7802 是控制服务，不是网关代理：`/config`、`/setup`、`/model-sync`（另有诊断用的 `/diag`），**没有** `/start` `/stop`，也**没有** `/model-config`——上下文窗口和思考强度只在网关 `/models` 页改（`POST /api/models/settings`）。网关启停归 `docker compose`。
- **DSH 的 provider 只认 `apiKeyEnv`**（凭据引用），没有 `apiKey` 字段——这是插件必须存在的原因：profile 在笔记本、网关在容器里，没人能替用户把 key 塞进 DSH 的凭据库。看 `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js` 的 `profile` schema 与 `resolveApiKey()`。

## 开源发布

**这个仓库直接发布到 GitHub**，不再走 `packaging/make-public.mjs` 那套「生成剥了注释的
发布版」的流程——每次发版都要重新生成、还要在生成目录里重跑测试，太麻烦。

靠 `.gitignore` 挡住不该公开的东西（**全在 `private/` 里**）：

    private/docs/     逆向记录、协议分析、内部重构方案
    private/tools/    逆向探针脚本（qoder-probe / anti-re-probe / mitm / wsl-docker）
    private/probes/   解包出来的大文件：Qoder asar+deb+CLI（2.8 GB）、Loomy asar（690 MB）

另外 `cb-gateway/data/`（明文 token、密钥、账本）也忽略。

`private/` 里跟着代码在同一个工作目录、随时能查，只是不进公开仓库。源码注释里
`private/docs/xxx.md` 的引用指向它——公开后读者看到的是一个不存在的路径，但至少
明确告诉了他「这里有份内部文档」。

**发布前必须自查的三件事**（都踩过）：

1. **`git status --ignored` 看一眼有没有该忽略却没忽略的**。2026-11-10 目录改名后
   `qb-gateway/data/` 那条规则失效，557 个文件（含 `auth/keys.json`、`usage.jsonl`）
   被提交进去——`.gitignore` 里的路径和实际目录对不上不会报错，只会静默失效。
2. **跟踪文件里不许有内网 IP、真实账号名、SSH 用户名**。用这个查：

       git ls-files | ForEach-Object { Select-String -Path $_ -Pattern '10\.0\.0\.|万里' }

3. **`private/` 的路径改动 = 同时改 `.gitignore` 和所有引用**。源码注释、`AGENTS.md`
   的文档表、各 README 都指向它，漏一处就是死链。

发布版里**保留代码注释**。这是刻意的：注释记的是「为什么这么做」和踩过的坑，
对读源码的人有用；而 `make-public.mjs` 那套剥注释的做法会把「为什么」一起删掉，
只剩下代码字面意思。

### 推送到 GitHub

公开仓库是 `https://github.com/wanlinus/CreditBridge`。**22 端口不通、只有 443 通**，
所以 remote 用 `ssh://git@ssh.github.com:443/...`——这样不必改 `~/.ssh/config`：

```powershell
git remote add origin ssh://git@ssh.github.com:443/wanlinus/CreditBridge.git
git push -u origin master
```

**不要用 `--force`**：现在推的是这个仓库的真实历史，和远端有共同祖先（如果远端还是
旧版 make-public 生成的独立历史，第一次推会被拒，那时才需要 `--force` 覆盖一次）。

## 提交

- 提交信息用中文，格式 `范围: 描述`，例如 `插件: 侧边栏入口改名 积分桥`、`修复: Trae 签到的 9074`。
- 提交前确认 `tsc --noEmit` 为 0、`git status` 里没有意外的未跟踪文件。
