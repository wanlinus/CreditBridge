# CreditBridge（cb-dsh）：DSH 插件

> **插件有两个职责：**
>
> 1. **把「网关在哪、用什么 key」写进 DSH 配置**（主要职责，见下）；
> 2. **给「必须走环回」的登录回调开一条本机 TCP 转发**（见[登录回调通道](#登录回调通道trae-专用)）。
>
> 侧边栏的面板是两个输入框加一个「保存」。点保存后 host 半边做四件事：
> **把 key 存进 DSH 凭据库** → 写 profile 的 provider（`baseURL` + `apiKeyEnv`）→
> 存配置 → 拉 `/api/models` 写 `models:` 段。
> **重启 DSH 后模型选择器里直接有东西可用。**
>
> **profile 里不放 key**，只放引用 `apiKeyEnv: <名字>`；真值进 DSH 自己的凭据库
> （`~/.dsh/.credentials.yaml` 的 `refs`）。这是 DSH 唯一的认证通路——`llm-pi-ai` 的
> provider schema 里没有 `apiKey` 字段，`resolveApiKey()` 只读 `profile.apiKeyEnv`。
> 现有 provider 已经有 `apiKeyEnv` 时**沿用它**（比如 `JF_API_KEY`），只换那条引用的值。

| 插件要的东西 | 网关给它的地方 |
|---|---|
| 模型清单（写 profile 用） | `GET /api/models` |
| 输入框右侧那个积分徽标 | `GET /api/accounts/<id>/badge`（文案）+ `GET /api/channels`（图标） |
| 哪些账号属于网关 | `GET /api/health` 的 `accounts` |
| **登录要开哪条回调通道** | `GET /api/events`（SSE 事件流） |

网关跑在哪由用户填：默认 `http://127.0.0.1:7801`，本项目的实际部署是开发机 `192.168.1.100:7801` 上的 Docker 容器（部署与运维见 [`cb-gateway/README.md`](../cb-gateway/README.md)）。插件**不管网关启停**——启停归 `docker compose up -d` / `down`，改网关源码要 `build`。早期 7802 上有 `/start` `/stop`，网关搬进容器后它只会拉起本地第二份网关、跟容器抢同一批凭据，已删。

---

## 登录回调通道（Trae 专用）

**问题**：Trae 的授权页只肯把浏览器跳回**环回**地址（`http://127.0.0.1:<port>/authorize`）。
网关绑回环时这没问题；但网关搬进容器之后，浏览器在你笔记本上打开，`127.0.0.1` 指的是
**笔记本自己**，容器里的回调服务永远收不到请求——表现是「授权完了但页面报错」。

填内网 IP（`http://192.168.1.100:18801`）不行：2026-11-09 实测两次，Trae 页面始终没把请求
发出来（分不清是它校验了回调地址，还是 Chrome 的 Private Network Access 拦了
「公网页面 → 内网 IP」）。所以只剩「本机接住再转发」这一条路。

**做法**：host 半边常驻一条 SSE 连到网关的 `GET /api/events`。网关在用户点「登录」的
瞬间推一条事件：

```
event: login
data: {"type":"login","channelId":"trae","state":"running","loopback":{"port":18801,"path":"/authorize"}}
```

插件收到就在本机 `net` 起 TCP 转发 `127.0.0.1:18801` → `<网关 host>:18801`，其余状态
（`done` / `error` / `cancelled`）关掉。**全程不需要 ssh、不需要人工开隧道。**

几个刻意的选择：

- **用 SSE 而不是轮询**：从「点登录」到「浏览器跳回」可能只有两三秒，轮询会错过，
  而错过的表现是「授权完成却没人接」。
- **用纯 TCP 转发而不是 spawn `ssh -N -L`**：不依赖 ssh 二进制/密钥/known_hosts，
  Windows 上一样跑；回调就是 HTTP over TCP，纯字节搬运足够。
- **目标是环回且端口相同就拒绝**：`127.0.0.1:18801 → 127.0.0.1:18801` 会绕回自己。
  网关在本机（`gatewayBase` 是 `127.0.0.1`）时恰好是这种情形，而那种部署本来也不需要转发。
- **网关是 `https://` 时不开**：回调是明文 HTTP，走 HTTPS 前置代理纯 TCP 转发会握手失败，
  日志里会说清楚而不是让你对着「登录没反应」发呆。

断线就重连（5 秒），断线期间的事件不补发——插件没连着的时候你本来也开不了登录通道。

---

---

## 两个半边

| 半边 | 文件 | 运行位置 | 职责 | 生效方式 |
|---|---|---|---|---|
| host | `lib/index.js` | DSH 主进程 | `127.0.0.1:7802` 控制服务（`/config`、`/setup`、`/model-sync`、`/diag`）；15 秒一次的模型同步；`lib/profile-models.js` 干实际写盘；`lib/events-client.js` 订阅网关 SSE；`lib/tunnel.js` 开登录回调的 TCP 转发 | **必须重启 DSH** |
| client | `lib/client.js` | DSH 渲染进程 | 输入框右侧徽标 + 上下文窗口下拉、侧边栏「积分桥」配置向导；所有网关请求走 `gwFetch()` | 按文件 mtime **热重载** |

host 半边在进程启动时求值一次，改它不会重新监听 7802。端口默认 7802，可用 `QB_DSH_CONTROL_PORT` 覆盖，但 client 半边只探测 7802…7811，挪出这个区间面板就连不上——仅用于排查。client 的 `exports.inject = ["slots"]` 是必须的：没有它 `apply()` 会在 slots 服务存在之前跑，注册静默失败。

---

## 侧边栏面板：配置向导

侧边栏「插件」组里的 **积分桥** 条目（order 5，夹在 Plugin Hub 和 自动化任务 之间）。点进去是：

| 控件 | 字段 | 说明 |
|---|---|---|
| 网关地址 | `gatewayBase` | 必须 `http://` 或 `https://`，尾部斜杠会被去掉 |
| API key | `apiToken` | 网关 `/keys` 页建的 `sk-…`（和 OpenAI key 同形），整套只有这一种凭据 |
| 保存 | — | 一次提交，host 半边串起「存配置 → 存凭据 → 写 provider → 同步模型」 |

下面是最近一次模型同步的结果（时间、写入个数、失败原因）。

**没有启停按钮、没有通道行、没有签到**——那些是网关网页的活。面板只回答一个问题：「DSH 现在连的是哪个网关、用哪把 key」。

保存的四步是**有顺序的**，顺序反了会留下中间态：

1. 校验地址和 key；
2. `credentials.set(<引用名>, key)` —— 先存凭据，因为 profile 引用的就是它；
3. 写 profile（`baseURL` + `apiKeyEnv`，顺手删掉残留的明文 `apiKey` 行）；
4. 拉 `/api/models` 写 `models:`。

**模型同步失败不算保存失败**：前两步已经落盘、profile 也改好了。`/setup` 回 `200`
带 `sync.ok:false`，面板显示「已保存，但拉模型失败：…（key 可能无效或网关没起来）」。
硬失败（地址不合法、没填 key、profile 里没有 `llm-pi-ai`、凭据库写不进去）才回 400/500。

配置落 `~/.dsh/cb-dsh/config.json`，在插件包和 profile **之外**（重建插件包、重装插件都不该把「网关在哪、怎么进」冲掉）。文件里只有 `gatewayBase` 和 `apiToken`。**key 是明文存盘的**，和 DSH 凭据库（`~/.dsh/.credentials.yaml`）、网关 `data/auth/keys.json` 里的哈希同一级别：能读到文件就能冒充你。单机单用户接受这个取舍；别把配置放进代码仓库或备份。

### 没配置时是「未配置」，不是「离线」

判定只看**存下来的** `gatewayBase` 和 `apiToken` 都在（`configured = storedBase && apiToken`）。两个缺一个就是未配置——只有地址没 key，网关每个接口都 401；只有 key 没地址，连不上。这两种半配置状态下硬去请求，用户看到的是「一直在失败」，而真相是「你还没配完」。

未配置时：

| 位置 | 行为 |
|---|---|
| 面板 | 顶部一条横幅「还没配置网关…」，填好保存后消失 |
| 积分徽标 | 显示 **未配置**（不是「离线」），不发请求、不给链接——那是在说「你还没告诉我去哪」 |
| 模型同步 | **直接跳过**，不发网络请求；`/model-sync` 回 `{ok:false, configured:false, error:"还没配置网关地址和 API key"}` |
| SSE 事件流 | 不启动（否则每 5 秒一条重连失败日志） |

`/config`（GET/POST）和 `/setup` 的响应都带 `configured` 字段，面板据此渲染。**用 `storedBase` 判断，不能用合并后的 `gatewayBase`**——后者有兜底默认值（`QB_DSH_GATEWAY` 或 `http://127.0.0.1:7801`），拿它判会把「什么都没配」当成「配过了」。

> 早期版本的 `config.json` 里有 `username` / `password`（Basic 认证）。v2 E 阶段把 Basic 删了，这两个字段读进来就丢，**为它填账号密码现在只会 401**。

---

## 控制服务（7802）

默认只监听 `127.0.0.1`，只做「配置 + profile 模型编辑」，不是网关也不代理网关请求。排查时可显式设 `QB_DSH_CONTROL_HOST=0.0.0.0` 让别的机器直连（客户端会退化成用页面主机名，Host 守卫仍按 IP 字面量放行）。

| 路由 | 请求 | 响应 |
|---|---|---|
| `GET /config` | — | `{ ok, gatewayBase, apiToken, storedBase, configured, default }` |
| `POST /config` | `{ gatewayBase?, apiToken? }`，只改传了的 | `{ ok, gatewayBase, apiToken, configured }` |
| `POST /setup` | `{ gatewayBase, apiToken }` | `{ ok, gatewayBase, configured, credentialRef, provider, sync }`——面板「保存」打的就是它。**`sync.ok:false` 时仍回 200**（保存成功、只是拉模型失败） |
| `POST /diag` | 面板侧自述诊断（`location` / `CONTROL_HOST` / 每个探测结果） | `{ ok: true }`——只写一行日志，方便排查 `Failed to fetch` |
| `GET /model-sync` | — | `{ ok, state: { at, ok, error, wrote, models, backup, trigger } }`（只读上一次结果） |
| `POST /model-sync` | — | 立刻跑一次同步，返回同样的 summary；失败回 500 |

- `default` 是 `normalizeBase(QB_DSH_GATEWAY || "http://127.0.0.1:7801")`，配置里没有 `gatewayBase`（或非法）时才用。
- `POST /config` 的 `gatewayBase` 非法回 `400 { ok: false, error: "网关地址要写成 http://主机:端口" }`，请求体不是 JSON 同样 400；保存写一行日志到 `~/.dsh/cb-dsh/plugin-host.log`（**只记地址和有没有 key，不记 key 本身**）。
- `POST /setup` 的顺序：`credentials.set(ref, key)` → `writeProvider()` → `writeConfig()` → `runModelSync()`。`apiToken` 为空直接 400；**没有 credentials 服务**回 500 并提示去 DSH 设置页填 key——不硬写 `~/.dsh/.credentials.yaml`，那个文件由 credentials-local 用文件锁 + 原子替换管理，自己写会和它的写入抢，最坏把 `records:` 里的登录态冲掉。
- **`writeProvider()` 会自己把结构补齐，不要求用户先手工加 provider**。三种残缺形态都认：`providers: {}`（DSH 一个 provider 都没有时写的就是这个）、有 `config:` 但没有 `providers:` 键、连 `config:` 都没有。第一种会把行内空映射换成块形式再插，后两种补出缺的键，缩进按 profile 现有层级算（`  config:` → `    providers:` → `      qb:` → `        baseURL:`）。只有 profile 里**整个 `llm-pi-ai` 条目都没有**才报错——那不是插件能造的。
- **`credentials` 只能用 `ctx.inject(['credentials'], cb)` 拿，不能在 `apply()` 里 `ctx.get()`**：那一刻服务还没 provide，`get` 返回 `undefined`，面板就会报「这个 DSH 没有可用的 credentials 服务」（2026-11-10 就是这个错）。`cb` 在服务就绪后才跑；另外 `getCredentials()` 每次用之前还会从宿主 ctx 现取一次兜底，不依赖回调时序。
- 两个环境变量只为测试存在：`QB_DSH_PROFILE`（profile 路径）、`QB_DSH_CONFIG_DIR`（`config.json` + 日志的目录）。**两个都要设**——只设前者的话 `/setup` 仍会写真配置，把用户的地址和 key 覆盖掉（踩过）。
- 校验 **`Host` 头**（只放行 IP 字面量——含 `127.0.0.1` / `[::1]`——和 `localhost`，带可选端口）防 DNS rebinding，**不校验 `Origin`**：渲染进程的 Origin 不可预测，按它白名单会把面板自己全挡成 403。放行局域网 IP 是因为面板可能在手机上打开，那时 Host 是 `192.168.1.10:7802`。
- 除上述路由外一律 `404 { ok: false, error: "no route" }`；**没有 `/start` `/stop` `/state`**，也没有任何 spawn 网关的代码。

---

## 模型清单同步

**这是插件存在的主要理由**：profile 在笔记本上，网关在容器里读不到它，所以「把模型写进 profile」只能由 host 半边做。

host 半边每 **15 秒**轮询一次 `GET /api/models`（带着 key），把结果写进 profile 里**那个 provider**（`baseURL` 的路径正好是 `/v1`）的 `models:` 段，字段是 `id` / `name` / `contextWindow` / `maxTokens` / `input` / `reasoningEfforts`。

- 判定用 **URL 的路径正好是 `/v1`**，不能用 `endsWith('/v1')`——`/workbuddy/v1` 也以 `/v1` 结尾，那是 v1 的按通道拆的条目，会把模型写进错的地方。
- 按 id 合并，**未知字段逐行保留**，不做 YAML 往返序列化；改写前后逐字节比对，一样就不写盘（所以轮询不会每 15 秒攒一堆备份）。
- 写盘前备份到 `cordis.patch.yml.bak-model-sync-<ISO>`，只碰 `models:` 段。
- 空段写成行内 `models: []` 而不是光秃秃的 `models:`——后者是 YAML 的 `null`，DSH 拿它当「没配」还是「解析失败」说不清。
- 网关不可达时只记一次日志（同样的错误不重复刷），等下一次轮询。
- 手动触发：`curl.exe -X POST http://127.0.0.1:7802/model-sync`；状态看 `GET /model-sync` 或 `~/.dsh/cb-dsh/plugin-host.log`。

`reasoningEfforts` 全部由网关算，插件只做**格式转换**（数组 → DSH 的字典）：

- 网关对每个能思考的模型都会报一份非空表（上游没报就用 `FALLBACK_EFFORTS`），插件不再自己兜底。
- `none → off` 的归一也在网关做完了，插件只把 `off` 写成 `off: null`（pi-ai 读到「支持，但什么都不发」），其余档位键值同名。

**两套兜底意味着「网关报的」和「profile 里写的」不是同一个东西，而那种偏差不会报错。**

`contextWindow` 在 DSH 的模型条目 schema 里是**单值**，没有档位列表。插件把网关报的值
原样写进去；能在哪儿调、能调到多少，全在网关 `/models` 页决定。

---

## 输入框右侧的徽标

仅在当前会话的模型属于网关账号时渲染。**判据是模型 id 里的账号段**（`wb-1/hy4free` → 账号 `wb-1`）是否出现在 `/api/health` 的 `accounts` 里——**不是**拿 DSH 的 `provider` 路由名去比通道清单。

> 2026-11-10 修的一个 bug：原先比的是 `selection.provider`（DSH 路由名，比如 `jf`）和 `/api/health` 的 `channels` 键（通道 id，`workbuddy`），两边永远不相等，**徽标一个都不显示**。v2 的 profile 只有一个网关 provider，底下挂着各家通道所有账号的所有模型，所以「这是不是网关的模型」只能从**模型 id** 判断。

| 元素 | 含义 |
|---|---|
| `723` | 该账号的积分余额（`totalRemain`）；网关离线时显示「离线」并保留最后一次数字 |
| `已连接` | 该上游不提供余额查询，只能证明通道可用 |
| `今日 8.99` | 当天积分消耗（有积分时） |
| `今日 12M tok` | 当天 token 数（**积分是 0 时**——免费模型是真实存在的） |
| `今日 566 次` | 当天请求数（积分和 token 都拿不到时，比如全被中断） |
| 点击整个徽标 | 系统浏览器打开该账号的详情页 `/accounts/<账号 id>` |
| `⚙` | 上下文窗口下拉 |

**「今日」为什么分三种显示**（规则在网关的 `core/badge.ts`，插件只负责画出来）：WorkBuddy 的 `deepseek-v4.1-flash` / `hy4free` 上游 `usage.credit` 就是 `0`（免费模型），一直显示「今日 0」等于什么都不说，用户会当成 bug（2026-11-10 被这么问过）。所以按「有积分 → 显示积分；没积分有 token → 显示 token；都没有 → 显示次数」降级，每一档都是真实数据，绝不编数字。

徽标读两个接口：

- `/api/accounts/<id>/badge`——每 60 秒轮询。回 `amount`（主数字）、`today`（今日文案）、`title`、`note`。
  **文案怎么算在网关**：显示积分还是 token 是通道计费语义，不该让插件每加一个通道改一次。
- `/api/channels`——挂载时取一次，模块级缓存（记下 `base`，重挂载时发现地址换了才重取）。回通道图标（data URI）和兜底字母。
  图标整包十几 KB，**不跟着 60 秒轮询走**。

**账号 id 从模型 id 的前半段拆**，不是 `props.provider`。拿不到账号 id 就不发请求——打一条注定 404 的请求只会让徽标显示「离线」。探活失败保留上一次的数字，60 秒后自动重试。

图标按 `badge.channel` 取（网关回的是**通道 id**，如 `workbuddy`），和 `props.provider`（DSH 路由名，如 `jf`）不是一回事。**图标缺失时画 `badge.title` 对应的首字母**（`letter` 也是网关给的），不再静默留白。

> 2026-11 修的一个 bug：徽标在 Loomy 上只有数字、没有图标。原因是插件里那张内联的 `CHANNEL_ICONS` 常量表少了一行，而注释写着「缺了会退回名字首字母」——那段兜底**根本不存在**，实际是静默留白。现在图标跟着通道目录走（`cb-gateway/src/channels/<id>/icon.png`，由网关读成 data URI），插件里不再有任何通道资产。

徽标用普通 `<a target="_blank">`：DSH 主窗口的 `setWindowOpenHandler` 把 http/https 交给 `shell.openExternal`；不带 `_blank` 的 `window.open` 或直接改 `location` 会把 DSH 应用自身导航走。

**上下文窗口和思考强度都不在插件里设**——它们只有一个设置入口：网关 `/models` 页
（存在网关 `data/config.json` 的 `modelSettings`）。插件做两件事，都不涉及选择：

| 插件做的事 | 数据来源 |
|---|---|
| 把 `contextWindow` / `maxTokens` / `input` / `reasoningEfforts` 照抄进 profile | 网关 `GET /api/models`（网关已经把用户设置套进 `context_length` / `max_output_tokens` 了） |
| 把「缺省思考档」留给网关 | 网关在 `POST /v1/chat/completions` 里补——profile 里没有 per-model 默认档这个字段，写不进去 |

早先这里有一份 `min(profile 里已有值, 网关值)` 的合并逻辑，为的是「⚙ 改完不要被
同步覆盖」。⚙ 和它的 `/model-config` 都删了之后，那种合并只会让「网关显示的值」
和「profile 里写的值」各说一套，而且不报错——所以现在是照抄。

**改完仍要重启 DSH**：profile 只在启动时读一次。网关 `/models` 页的说明里也这么写。

> 想调小窗口省额度、或换一个默认思考档，去网关 `/models` 页改。改完 15 秒内同步进
> profile，重启 DSH 生效。思考档还有个额外效果：**客户端没发 `reasoning_effort` 时
> 网关直接补上**，那条是即时生效的，不用等重启。

**上下文窗口改完按提示重启 DSH**：profile 只在启动时读一次。网关 `/models` 页的说明里也这么写。

---

## 插槽

| 插槽 | 注册 id | 用途 |
|---|---|---|
| `conversation.input.right` | `credit-bridge` | 输入框右侧：余额徽标（上下文窗口下拉已删，设置搬到网关 `/models` 页） |
| `sidebar.panellist` | `dsh-credits` | 侧边栏「插件」组里的 积分桥 入口（`order: 5`） |
| `main`（keyed） | `dsh-credits` | 面板本体：两个输入框 + 保存 + 同步状态 |

两个 `dsh-credits` 必须成对：侧边栏行点击会调 `ctx.layout.selectPanel(id)`，`main` 里没有同 `key` 的注册时抛错且不切换。徽标条件走 `CreditsGate`：`modelDirectories.directoryFor(sessionId).store` 的 `getSnapshot().current.model` 里拆出的**账号段**属于网关账号才渲染，账号清单拿不到时按「模型 id 里含 `/`」兜底首屏；侧边栏行和面板注册放在 `modelDirectories` 注入之外，任何模型下都要可达（`apply()` 里两段独立 try/catch，互不牵连）。

插件里**不再有任何通道图标资产**。图标来自网关 `GET /api/channels`（data URI——面板跑在 `dsh-app://` 下，直连网关取图要过一段没验证过的 CSP），按 `badge.channel` 查；缺图时用网关给的 `letter` 画字母块。加通道只要往 `cb-gateway/src/channels/<id>/` 丢一张 `icon.png`，插件不用动。

---

## 开发

DSH 加载的是**安装副本**，不是本目录源码：`$env:USERPROFILE\.dsh\profiles\desktop\node_modules\cb-dsh\lib\`。桌面 profile 由 Electron 独占管理，`dsh plugin --profile desktop` 会被拒绝，重装 / 升级走 GUI 插件页。

```powershell
$dst = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\cb-dsh\lib"
Copy-Item .\lib\client.js $dst\client.js -Force   # mtime 热重载，立即生效
Copy-Item .\lib\index.js  $dst\index.js  -Force   # 要重启 DSH 才重新监听 7802
(Get-FileHash .\lib\client.js).Hash -eq (Get-FileHash "$dst\client.js").Hash
(Get-FileHash .\lib\index.js).Hash  -eq (Get-FileHash "$dst\index.js").Hash
```

哈希不等就是没同步，别信「复制成功」。

**测试**：`npm test` 跑八个：

| 文件 | 覆盖 |
|---|---|
| `test/profile-models.mjs`（23 项） | 模型写进 profile 的合并规则、空段写法、字段重算；`contextWindow` 一律照抄网关（不再保留 profile 里的旧值） |
| `test/write-provider.mjs`（43 项） | `inspectProvider` / `writeProvider`：定位、改 `baseURL`、写 `apiKeyEnv`、删残留明文 `apiKey`、参数校验、不误伤 v1 条目；**`providers: {}` / 没有 providers 键 / 没有 config 键三种残缺 profile 都能自动补齐** |
| `test/setup.mjs`（21 项） | `/setup` 全链路：真 host 半边 + 桩网关 + 假 credentials，验证「凭据先写、profile 只留引用、key 无效时仍算保存成功、配置落在临时目录」 |
| `test/badge-strip.mjs`（17 项） | 徽标渲染回归：插件源码里不再有内联图标、网关给的 data URI 真的画成 `<img>`、只有字母时画字母块、只轮询 `/badge` 一个端点 |
| `test/tunnel.mjs`（23 项） | 环回转发器：真的搬字节（回显服务器）、同主机同端口的自环被拒、幂等、关得干净、非法端口 |
| `test/events-client.mjs`（15 项） | SSE 客户端：帧解析（多行 `data` 拼成一条）、注释帧不算事件、`stop()` 之后不再收、401 只记日志不抛错 |
| `test/not-configured.mjs`（14 项） | 「没配置」分支：`configured:false`、半配置仍算未配置、同步跳过且不发请求、配齐后翻成 true 并能真的发出请求 |

> **这些测试直接 import `lib/index.js` 的真代码**，用 `QB_DSH_PROFILE` + `QB_DSH_CONFIG_DIR` 指向临时目录。早先 `write-provider.mjs` 的做法是「把函数体抽出来、缺的辅助函数自己补一份」——于是 `index.js` 里 `providerAbove` / `blockEnd` 两个**从没定义过**的引用被测试的桩补上了：测试全绿，用户点保存必炸 `providerAbove is not defined`。别再回到「抽源码 + 自带桩」那种写法。

**打包安装**（正式路径）：`pnpm pack`（产 `cb-dsh-<version>.tgz`，当前 `0.10.2`）→ 放进 `packages\`（`.gitignore` 已忽略 `*.tgz`）→ 改 `~\.dsh\profiles\desktop\package.json` 里的 `dependencies` 指向新包（`dsh.profile.bundles` 写的是包名 `cb-dsh`，升版本不用改）→ 删同目录 `pnpm-lock.yaml`（`integrity` 变了，不删报 `ERR_PNPM_TARBALL_INTEGRITY`）→ `pnpm install --dir ~\.dsh\profiles\desktop` → 哈希比对（源码 / 包内 / `node_modules\cb-dsh` 三处的 `lib/client.js` 必须一致）→ **重启 DSH**。

**诊断打点**：`probe()` 把生命周期阶段 GET 到网关 `/api/plugin-probe`，落盘到网关 `data/logs/plugin-probe.log`（容器里在卷挂载的 `data/logs/`）：`factory → apply → inject-callback → inject-called → panel-inject-called → panellist-inject-callback → main-inject-callback → mount → fetch-ok`。两处 inject 回调的先后不定，各阶段都出现过即可；`*-error` 表示对应注册抛错，`fetch-error` 表示徽标那轮探活没打通。打点也走 `gwFetch()`，没配 key 同样 401，日志里会缺阶段。

`cb-gateway/tools/preflight-dsh.mjs` 是重启前自检（profile 非空、关键条目齐全、插件两半语法、有效备份、bundle 已安装且 `file:` 指向的 tarball 存在）。它里面那条「已登录通道必须有 `models:` 段」的检查是按 v1 写的，模型同步搬进插件之后已经过时——以插件面板显示的同步状态为准。

---

## 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 徽标显示「离线」/ 模型同步失败，网关回 401「未登录：先打开 /login…」 | 没配 key，或 key 不对/被停用 | 面板填网关地址和 `/keys` 页建的 key；对照 `~/.dsh/cb-dsh/config.json` 与网关 `/keys` 列表的前缀 |
| 徽标显示「离线」/ 模型同步失败，网关回 403「还没改过默认密码」 | 网关还是默认 `admin/admin`，`mustChangePassword` 闸没过 | 浏览器打开 `<网关>/password` 改密；改完之前除 `/login` `/password` `/logout` 外一律拒绝，DSH 对话也会 401 |
| 保存后提示「profile 里没有 llm-pi-ai 条目」 | DSH 里还没有任何 OpenAI 兼容 provider | 先在 DSH 设置里加一个，再回来保存 |
| 保存成功但 DSH 里没有模型 | 还没重启 DSH（`models:` 是启动时读的），或同步那一步失败 | 看面板下方的同步状态和 `plugin-host.log`；手动 `curl.exe -X POST 127.0.0.1:7802/model-sync` |
| 改完 `lib/index.js` 没反应 | host 半边只在 DSH 启动时求值一次 | 同步到 `node_modules\cb-dsh\lib\` 并**重启 DSH**，用哈希确认 |
| 网关加/删模型后 DSH 列表没变 | 同步没跑或对不上 profile 里的 `baseURL` | `GET 127.0.0.1:7802/model-sync` 看上次结果；写坏了有 `.bak-model-sync-*` 可回滚 |
| 上下文窗口/思考强度改不了 | 网关 `/models` 页才是设置入口（插件里已经没有 ⚙） | 在网关 `/models` 页那一列改；没实现 `catalogOf()` 的通道（Qoder / Loomy）没有可选档位表，上下文窗口是自由填的数字框 |
| 改完上下文窗口没生效 | profile 只在 DSH 启动时读一次 | 重启 DSH。思考档不用重启——那是网关在请求处注入的 |
| 徽标显示「离线」但网关是好的 | 那轮 `/api/accounts/<id>/badge`（徽标轮询）或门禁用的 `/api/health` 失败（key 无效、账号被删、模型 id 里没有账号段） | 看 `plugin-probe.log` 的 `fetch-error`；单次失败保留最后一次数字，60 秒后自动重试 |
| 面板里没有新通道 | 网关注册表没登记，或 `/api/health` 的 `channels` 没带回 | 确认 `src/channels/index.ts` 加了那一行，然后在开发机重跑 `.\cb-gateway\scripts\deploy.ps1`；插件侧不需要改代码 |
