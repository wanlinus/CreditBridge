# 网关架构

网关把 DSH 说的标准 OpenAI 协议，翻译成四家上游（WorkBuddy / Trae / Qoder / Loomy）的私有协议，用**指定账号**的额度付账。认证边界在进程内（Hono 中间件的一道闸），不是网络防火墙：绑 `0.0.0.0` 后同网段任何机器都能连 7801，闸只认凭据。部署、路由清单、排错见 `README.md`。

v2 之后它只有一个对外入口：`/v1/*`（OpenAI 兼容）+ `/api/*` 和页面（管理台）。**没有通道前缀路由了**——通道只作为模型 id 的前半段存在。

---

## 〇、全景图

```
                          ┌───────────────────────────────────────────────┐
   笔记本 · DSH 进程       │  其他客户端（脚本 / curl / 别的 OpenAI 客户端） │
                          └───────────────────┬───────────────────────────┘
                                              │  Authorization: Bearer sk-…
                                              ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  cb-gateway  :7801        （容器 192.168.1.100 或本机，单进程）                    │
│                                                                              │
│   app.ts  中间件链                                                            │
│   ┌────────────────────────────────────────────────────────────────────┐     │
│   │ ① 请求日志  ② CORS（白名单含 dsh-app://）  ③ 回环 Host 闸（仅 POST）│     │
│   │ ④ authGate（Bearer key 或 会话 Cookie）  ⑤ passwordGate（未改密拦） │     │
│   │ ⑥ bearerOnlyGate（**只在 /v1/* 上**：Cookie 不算，必须带 key）       │     │
│   └────────────────────────────────────────────────────────────────────┘     │
│                                    │                                          │
│        ┌───────────────────────────┼───────────────────────────┐              │
│        ▼                           ▼                           ▼              │
│  ┌───────────┐             ┌─────────────┐            ┌──────────────┐        │
│  │  OpenAI   │             │  管理 API   │            │  页面 / 动作 │        │
│  │  /v1/*    │             │  /api/*     │            │  / …（Cookie）│       │
│  │ 只认 key  │             │ key 或 Cookie│           │  表单 POST303│        │
│  └─────┬─────┘             └──────┬──────┘            └──────┬───────┘        │
│        │                          │                          │                │
│        └──────────────┬───────────┴──────────────────────────┘                │
│                       ▼                                                        │
│         ┌─────────────────────────────────┐                                   │
│         │  core/  编排（不认识通道名）      │                                  │
│         │  router · accounts · credits · keys ·                             │
│         │  login-tasks · events · checkin-scheduler · checkin-log            │
│         └──────────────┬──────────────────┘                                   │
│                        │  channels[]  注册表（自述 id/idPrefix/label/identity）│
│                        ▼                                                      │
│   ┌──────────────┬──────────────┬──────────────┬──────────────┐              │
│   │  workbuddy   │     trae     │    qoder     │    loomy     │  适配器层    │
│   │  wb · 多号   │  tr · 多号   │  qd · 多号   │  lo · 多号   │              │
│   └──────┬───────┴──────┬───────┴──────┬───────┴──────┬───────┘              │
│          │              │              │              │                      │
│  ┌───────┴──────┐ ┌─────┴─────┐ ┌──────┴──────┐ ┌─────┴──────┐              │
│  │ 磁盘 data/   │ │ 日志       │ │ SSE 推送    │ │ 品牌图标    │              │
│  │ gateway.db   │ │ logs/      │ │ /api/events │ │ icon.png    │              │
│  │ state/ logs/ │ │            │ │ → 插件      │ │ → data URI  │              │
│  └──────────────┘ └────────────┘ └─────────────┘ └────────────┘              │
└──────────────────────────────────────────────────────────────────────────────┘
           │                    │                    │                   │
           ▼                    ▼                    ▼                   ▼
   copilot.tencent.com   trae-api-cn          gateway/openapi        loomyad.xunfei.cn
   + www.codebuddy.cn    .mchost.guru         .qoder.com.cn          + account.xfinfr.com
   （纯 HTTP）            （纯 HTTP）           （CLI + HTTP）          （纯 HTTP）
```

**读图的三个要点**

1. **三层路由是边界，不是命名习惯**：`/v1/*` 只认 Bearer key（由 `bearerOnlyGate` 强制，不是靠文档约定）、`/api/*` 认两种凭据、前端产物公开（只是静态文件，不含数据）。混层会立刻出现「三个 `/models` 长得一样」。混层会立刻出现「三个 `/models` 长得一样」。
2. **core 不认识通道名**：它只读 `channels[]` 注册表。所以加通道只改两处（`src/channels/<name>/` + 注册表一行）。
3. **两条反向依赖是设计的一部分**：`channels → core`（拿 `usableCredential` 刷新凭据）和 `core → channels`（查注册表找通道）。除此之外层与层单向向下。

---

## 一、三个层次

```
请求  POST /v1/chat/completions  {"model":"wb-2/hy4free"}
  │
  ├─ 路由层  routes/*         模型 id → 通道 + 账号 + 上游模型 id；判账号状态；记账
  │                          （core/router.ts、core/accounts.ts）
  ├─ 适配器  channels/*       拿 account.credential 打上游，把回答翻译成 OpenAI 形状
  │                          不知道「这个通道挂了几个号」
  └─ 上游    copilot.tencent.com / trae-api-cn / gateway.qoder.com.cn + 本地 CLI
             loomyad.xunfei.cn
```

模型 id 回答「用哪个账号的哪个模型」，key 回答「谁能用」。两件事拆开，各自可以单独改——**没有「网关替你挑账号」这层**，因为那会让账单对不上（见「关键不变量」）。

---

## 二、四个通道对比

| 通道 | `idPrefix` | 多账号 | 对话怎么走 | 额度/签到 | 登录形态 |
|---|---|---|---|---|---|
| WorkBuddy | `wb` | ✅ | 纯 HTTP `/v2/chat/completions`（原样透传 OpenAI chunk） | `/v2/billing/*` | 网页授权（URL） |
| Trae CN | `tr` | ✅ | 纯 HTTP（私有方言，需双向翻译） | `batch_get_detail_param` + 签到接口 | 网页授权（URL，**要环回回调**） |
| Qoder | `qd` | ✅ | 纯 HTTP SSE（COSY 签名，外层包内层） | `/sash/*` | 设备码授权（一次） |
| Loomy | `lo` | ✅ | 纯 HTTP `/api/v1/chat/completions`（原样透传） | `/api/v1/points/records` | **短信验证码表单**（`onPrompt`） |

**四个通道都是纯 HTTP，没有子进程。** Qoder 曾经要起常驻 CLI 子进程（对话靠它的登录态），
2026-11-22 逆出 COSY 签名（一块 wasm 从 `dt-` 现算 `encrypt_user_info` / `key`）之后 CLI
整条删掉了——顺带把「只能挂一个号」的限制也放开了。

四个通道的文件集也一致：`auth` / `login` / `models` / `upstream` / `usage` / `index`。
能力差异由 `typeof channel.x === 'function'` 自述（见 `core/channel-info.ts`）：
Loomy 没有签到（上游没这接口），其余三个都有。

---

## 三、组件

### 装配与生命周期

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 入口：读配置 → 收紧凭据目录权限 → `loadAccounts()` → 给每个通道 `configure()` → 建 Hono 应用 → `serve()`。加通道**不用**动它。 |
| `src/app.ts` | Hono 实例：请求日志、CORS（白名单含 `dsh-app://`）、回环 Host 闸、`authGate`、`passwordGate`，再挂四组路由。 |
| `src/lifecycle.ts` | 停机钩子（`/api/shutdown` 的回调槽，避免路由和入口互相引用）、父进程看护、启动预热。 |
| `src/logger.ts` / `src/config.ts` | 按天写 `data/logs/`；配置从 `data/config.json` 读一次，但 `checkinTime` 可经 `updateConfig()` 运行期写回并原地更新。可见性和模型设置**不在这个文件里**（在 `channel_visibility` / `model_setting` 两张表），因为它们要改完立刻生效。 |

### 路由
| 文件 | 职责 |
|---|---|
| `src/routes/openai.ts` | **OpenAI 层**：`GET /v1/models`（`modelListPayload()` 也供 `/api/models`）与 `POST /v1/chat/completions`（解析 id、判状态、转发、记账、改账号状态、包装 SSE）。 |
| `src/routes/admin.ts` | **管理 API**：`/api/health`、`/api/channels`、`/api/models`、`/api/models/catalog`（含 `lengths`/`efforts`/`setting`）、`/api/models/settings`、`/api/models/visibility`（只认 JSON）、`/api/usage`、`/api/usage/hourly`（单日 24 小时）、`/api/checkin/log`、`/api/shutdown`。2026-11-22 曾按主题拆成 4 个文件，随后合回来——拆完 `usage.ts` 只剩 35 行代码、`admin.ts` 只剩 11 行纯组合器，读一个端点要先判断它在哪个文件里。 |
| `src/routes/events.ts` | `/api/events`（SSE 长连接）、`/api/plugin-probe`（插件诊断打点）。两条都是**插件排错通道**，不是业务资源。 |
| `src/routes/accounts.ts` | 账号：`/api/accounts/*`（列表、详情、改名/停用、删除、验活、登录任务、签到、余额、账本）。**没有页面**。 |
| `src/routes/keys.ts` | API key：`/api/keys/*`。新建时明文直接回在响应体里（旧版的 `pendingSecrets` 内存中转随页面层一起删了）。 |
| `src/routes/json-actions.ts` | 跨资源的写端点：登录/退出/改密、`PATCH /api/config`、`POST /api/checkin/all`、上游退出、换设备号、取消登录任务。 |
| `src/app.ts` 的 `createSpaApp()` | **前端托管**：`serveStatic` 出 `web/dist`，`get('*')` 兜底回 `index.html`。它是**最后挂的兜底路由**，且 `api/`、`v1/` 段一律回 404 JSON。 |

### 核心

| 文件 | 职责 |
|---|---|
| `src/core/accounts.ts` | 账号的状态机与内存副本：`account` / `account_seq` 两张表（`store/accounts.ts` 管 SQL）、`ready/cooldown/invalid/disabled`、`usableCredential()`（过期刷新 + 并发单飞）。**没有调度器**。 |
| `src/core/router.ts` | 模型 id 的拼装/拆解（`wb-1/hy4free`）、显示名生成（`wb-1/Hy4 · 0.00x`）、解析失败的人话。 |
| `src/core/login-tasks.ts` | 「登录 → 账号」的接缝：起后台任务、轮询进度、按上游 uid 去重、单账号通道覆盖。任务状态变化时往 `core/events.ts` 推事件。 |
| `src/core/events.ts` | 进程内事件总线：网关 → 插件的单向推送（极薄，没有队列和重放）。目前只用于「登录开始了，去开回调通道」。 |
| `src/core/checkin-scheduler.ts` | 每日签到调度：到 `config.checkinTime` 点签一次；失败按阶梯重试——普通失败 1 小时后一次，通道标了 `transient` 的走 10/30/60 分钟——走完放弃。失败指**抛异常或返回 `status: 'error'` 记录**（三个通道都是后者）。启动时若已过点且今天没签则补签；无待签账号也留一行日志（否则「跑过但没事做」和「没跑」分不出来）。每次尝试追加进签到日志。**关掉开关的号会被跳过并留一条 `status: 'skipped'`（每账号每天一条）**，否则「关掉了」和「调度器没跑」在日志里长得一样。**手动 `checkinAllAccounts()` 不受开关限制**。 |
| `src/core/checkin-log.ts` | 签到历史：`checkin_log` 表（只追加，一行一次尝试，含 `source` 区分自动/手动）。和「当天幂等状态」分开——后者被下一次覆盖，历史不能。`skippedLoggedToday()` 给调度器判重：一天跑好几轮，同一个「被跳过」只该留一条痕。 |
| `src/shared/checkin-switch.ts` | **账号级签到开关的唯一实现**：`account.checkin_enabled` 列 + 内存索引。只管「要不要自动签」，不碰对话和余额（`status: 'disabled'` 才是整个号不用了）。**手动签到不受它限制**。 |
| `src/core/credits.ts` | 单账号余额信封（通道元数据 + 账号身份 + 本地签到记录 + 失败兜底）；`accountsWithSpend()` 是「这批账号的余额 + 今日消耗」的**唯一组装处**（概览页、账号页、`/api/accounts` 三处共用）。`CreditsView` 把「成功带余额 / 失败带 error」两种形状显式写出来——靠推断得到的 union 会让调用方在读取处才报错。 |
| `src/core/badge.ts` | **徽标文案的唯一组装处**：主数字（余额）+ 今日用量。显示积分还是 token 是**通道计费语义**（免费模型上游就报 `credit: 0`，一直显示「今日 0」用户会当 bug），所以算在网关——2026-11 之前算在前端，每加一个计费方式不同的通道就要改一次插件。 |
| `src/core/channel-icons.ts` | 通道品牌图标：读 `src/channels/<id>/icon.png` → data URI，内存缓存，缺失返回 `null` 不抛错。用 data URI 而不是图片 URL：插件跑在 `dsh-app://` 下，`img-src` 放不放行网关源没验证过，而 data URI 一直是通的。 |
| `src/core/checkin-store.ts` | 签到当天状态（`checkin_state` 表）的读写。原先三个通道各抄一份逐字相同的四个函数，和上游协议无关，所以下沉到 core。 |
| `src/core/keys.ts` | API key：`api_key` 表、**明文不落库**（2026-11-22 起 `secret` 列物理删除，只留 `salt` + `hash`，明文只在 `POST /api/keys` 的响应里出现一次）、按明文前缀筛候选、**校验结果存内存快照**（键是 `sha256(secret)`，命中直接放行、跳过 61ms 的 scrypt；TTL 默认 1 天、可在设置页改）。不能预热：`sha256(secret)` 需要 secret 本身，而库里只有不可逆的 scrypt 结果，所以每个 key 进程内第一次请求必然付一次 scrypt。 |
| `src/core/channel-info.ts` | **通道能力位与「取哪个号当样本」的唯一实现**。`capabilitiesOf()` 收口三个响应里重复的 `typeof channel.x === 'function'`（加第五个能力位时漏一处就是「那个按钮永远不显示」）；`primaryAccountOf()` 收口「优先 ready、其次第一个、都没有是 null」的取号规则（`/api/models/catalog` 与 `POST /api/models/settings` 共用）。 |
| `src/ledger.ts` | 账本：一行一次请求，聚合出 `totals` / `today` / `daily` / `byModel` / `byAccount` / `todayByAccount` / `recent`。**只写 `usage_record` 表、也只从它读**（`store/usage.ts`）。三段职责靠分节注释区分：写入口 `recordChatUsage`、汇总 `usageSummary`、单日 `usageHourly`，以及两条读路径共用的 `pricingRows`。2026-11-22 曾拆成 4 个文件，随后合回来（`record.ts` 只剩 35 行代码、`pricing.ts` 30 行）。 |
| `src/shared/db.ts` | **唯一的 SQLite 连接**：`node:sqlite` 的 `DatabaseSync`、三个 PRAGMA（WAL / synchronous / foreign_keys）、按 `user_version` 迁移（**当前版本 3**：v1 = 9 张表，v2 = `api_key` 去掉明文 `secret` 列并重建表，v3 = `account.checkin_enabled` 列）。不开连接池、不导出 `query()` 泛型助手、不封装 `transaction()`。`closeDb()` 只给测试用（Windows 上删不掉打开的文件）。 |
| `src/store/usage.ts` | `usage_record` 的**全部 SQL**（`SQL 只允许出现在本文件与 db.ts`）。导出语义化函数——`usageTotals` / `usageStatusCounts` / `usageDailyGroups` / `usageModelGroups` / `usageAccountGroups` / `usageAccountTokens` / `usageAccountToday` / `usageRecent` / `usagePricingRows` / `usageDurations`——返回 camelCase 领域对象而不是 row，且**全同步**。不做 Repository 模式的理由见 `private/docs/v4/README.md` §5.1。**两个窄查询（`usageAccountTokens` / `usageAccountToday`）不是宽查询的重复**：它们只取调用方真正要的两三个数字，替掉了两处「为一个徽标跑完整 `usageSummary()`」的浪费（徽标 4.85ms → 0.047ms），口径一致性由 `test:store-usage` 第 10 节钉住。 |

### 界面

界面**不在 `src/` 里**：它是独立的 Vue 3 SPA，源码在 `cb-gateway/web/src/`，构建产物 `web/dist` 由
`app.ts` 同源托管。服务端**不出任何 HTML 页面**（8 个 SSR 页面与 17 条表单动作已于 2026-11-13 删除）。

| 位置 | 职责 |
|---|---|
| `web/src/router/index.ts` | 路由表（history 模式）。`meta.section` 驱动导航高亮，`meta.title` / `meta.subtitle` 驱动标题区。 |
| `web/src/layouts/ShellLayout.vue` | 外壳：导航（计数来自 `/api/accounts` 与 `/api/keys`）、面包屑、标题、退出。 |
| `web/src/views/` | 页面。已实现：`OverviewView`、`DayUsageView`（单日 24 小时，点趋势图的柱子进来）、`AccountsView`、`AccountDetailView`、`ModelsView`、`CheckinView`、`KeysView`、`SettingsView`、`LoginView`、`PasswordView`、`NotFoundView`。 |
| `web/src/api/` | 每个资源一个模块（`accounts` / `keys` / `usage` / `channels` / `config`）。路径和请求体只写在这里。 |
| `web/src/components/` | 复用件：`StatusBadge`（四档状态色的唯一映射）、`ChannelIcon`、`CardPanel`、`MetricCard`、`TrendChart`（ECharts，按通道/模型/账号切维度）、`AccountRow`、`AddAccountPanel`、`LoginTaskPanel`。 |
| `web/src/styles/tokens.css` | 设计令牌：色板、圆角、定宽、四档状态色、图表色板（`--chart-1..8`）。 |
| `web/src/composables/` | `useAsync`（唯一的数据获取原语）、`useLoginTask`（登录任务轮询）。 |

### 通道

| 文件 | 职责 |
|---|---|
| `src/types.ts` | 跨边界类型：`Channel` 契约、`Account`、`ChannelIdentity`、凭据 / 模型 / 额度 / 签到 / 对话形状，共 21 个声明，靠分节注释区分。2026-11-22 曾按领域拆成 7 个文件，随后合回来——拆完 5 个文件的实际代码不到 30 行，读一个类型要先判断它在哪个文件里。 |
| `src/channels/index.ts` | 注册表 `channels`、`channelById()`、`channelByPrefix()`；模块加载时校验 `id` 和 `idPrefix` 的唯一性。 |
| `src/channels/types.ts` | `defineChannel()` 的运行时校验（必需成员、`idPrefix` 字符集、`identity` 非空）。 |
| `src/channels/<name>/` | 一家的协议适配，**四个通道文件集一致**：`auth.ts`（凭据刷新 + 请求头）、`login.ts`（交互式登录，含设备码/短信/回调三种形态）、`models.ts`（模型目录：`modelsOf` 与 `catalogOf` 的数据来源）、`upstream.ts`（对话翻译与转发）、`usage.ts`（额度/签到）、`index.ts`（通道对象，只做声明和转发）、`icon.png`（64×64 品牌图标，由 `core/channel-icons.ts` 读成 data URI，`GET /api/channels` 回出去）。`qoder/cosy/` 是例外（wasm 签名，与业务无关的独立边界）。**要改「模型目录」就知道该看 `models.ts`，不用先判断是哪家**。 |

### 共享与认证

| 文件 | 职责 |
|---|---|
| `src/shared/paths.ts` | `data/` 下所有路径的唯一来源。 |
| `src/shared/upstream-error.ts` | `UpstreamError`（带 HTTP 状态码和 `Retry-After`）。**路由层靠它改账号状态**。 |
| `src/shared/credential-error.ts` | `CredentialError`：在 `UpstreamError` 上加 `permanent`，「凭据要重新登录」vs「暂时换不到」。**丢掉 `permanent` 就会让过期账号永远显示「就绪」**，包装时用 `asCredentialError()`。 |
| `src/shared/atomic-write.ts` | `writeFileAtomic()`：tmp + fsync + rename。`data/` 下所有写盘都走它。 |
| `src/shared/model-visibility.ts` | 模型可见性：`channel_visibility` 表（v4 起进库），键是**短前缀**（`wb`）；总闸 `isListed()` + 逐模型清单 `visibleFor()`、`filterModels()` 给 `/v1/models` 用。改完不用重启。**行数据有内存索引**（`filterModels()` 一次要问两次，而 `/api/models` 每通道每账号各问一遍；实测 360 次从 7.06ms 降到 0.21ms），写路径 `saveRow()` 负责失效。返回的是副本——把缓存里的数组交出去的话，`setListed()` 拿它写库会顺手改掉清单。 |
| `src/shared/gateway-auth.ts` | 网页账号密码（scrypt）、会话（内存 Map，12 小时）、`extractBearer()`。**不认 key**——那是 `core/keys.ts` 的事。 |
| `src/auth/middleware.ts` | 三道闸，**只作用于 `/api/*` 与 `/v1/*`**：认证（API key 或会话 Cookie）→ 强制改密（`/api/login` `/api/logout` `/api/password` 豁免）→ `/v1/*` 只认 Bearer（`bearerOnlyGate`）。前端产物公开。 |
| `src/shared/openai-sse.ts` | SSE 分片解析、`usage` 提取、非流式聚合。参数类型是 `string` 不是 `any`——`any` 下传错一个非字符串会在流的读取循环里抛 `TypeError`，被当成「上游挂了」记成 502。 |
| `src/shared/json-body.ts` | **读请求体的唯一入口** `readJsonBody()`：坏 JSON 一律 400，空 body 当 `{}`。7 个写端点原先各写一遍 `JSON.parse(await c.req.text())` 且行为不一致（`POST /api/keys` 那处坏 JSON 静默当空，会建出一把「未命名」的 key）。只返回 `{ok, body}` / `{ok:false, message}`，错误信封由各路由自己拼（`/api/*` 用 `bad_request`，`/v1/*` 用 `gateway_error`）。 |
| `src/shared/build-info.ts` | `PACKAGE_VERSION` 和启动时间。**只在这里读一次** `package.json`——两处各读一次会导致 `/api/health` 和设置页报出不同的 `startedAt`。 |
| `src/app.ts` 的 `notFound` | 非 GET 的未知路径一律 404 JSON。GET 的未知路径由 SPA 兜底（前端显示 404 页）。 |
| `src/config.ts` | `config`（内存副本）+ **`config.json` 的唯一写入口 `mutateConfig()`**。别的模块不许自己写这个文件。 |

---

## 四、数据布局

```
data/
├─ config.json              网关配置（只有 host/port/checkinTime 三项），手改入口
├─ gateway.db               库：账本 / 账号 / key / 密码 / 签到 / 模型设置 / 可见性
│                            （SQLite，WAL 模式；**备份要连 -wal 一起拷**）
├─ state/qoder-models.json   Qoder 模型名单缓存（6 小时 TTL，删了会自动重取）
├─ state/trae-identity.json  Trae 的机器级设备身份（只存 machineId；selfDeviceId 已改成每账号一份，跟凭据走）
├─ state/qoder-identity.json Qoder 的设备身份
└─ logs/                     按天日志
```

**布局本身就是事实，不写迁移代码**（见 AGENTS.md「数据不做迁移」）。

v4 迁库前的 `usage.jsonl` / `auth/` / `accounts/` / `state/checkin/` / `state/checkin-log.jsonl`，
Qoder 常驻 CLI 时代的 `cli/`（88MB），以及 Trae「按请求结算」时代（2026-11-13 删）留下的
`state/trae-spend/`，都已于 2026-11-23 从生产删除——当时核对过 `usage_record` 有 9591 行覆盖
全部时间范围、`checkin_state` / `checkin_log` 表有 5 / 140 行、`account` 表 6 个号齐全，
删完 6 个账号仍全部 `ready`、签到读的是库里的当天记录，证明那些文件确实没有任何代码依赖。

`state/trae-identity.json` 里的 `selfDeviceId` 字段也一并删了：它是「设备号全机共用」时代的
产物，现在每账号一份、跟着凭据走，`previousIdentity()` 硬编码空串**故意不读**它。


**原子写只剩 `config.json` 用得上**（`shared/atomic-write.ts`：tmp + fsync + rename）。其余状态在库
里，由事务保证——SQLite 给不出「半截文件」这种状态。这也是进库的收益之一：原来「读坏文件就当
作没有」那一串降级路径（账号凭空消失、所有 key 一起失效、密码被重置成 `admin/admin`）整段消失。

`data/` 整个目录在 Windows 上由 `shared/data-permissions.ts` 收紧 ACL（Node 的 `mode` 在 Windows
上不生效），因为明文凭据都在 `gateway.db` 里，而 WAL 还会带出 `-wal` / `-shm` 两个附属文件——
只给主文件设权限等于白紧一半。

---

## 五、`Channel` 契约

定义在 `src/types.ts` 的 `Channel`（运行时校验在 `src/channels/types.ts`）。

**必需成员**：`id` `idPrefix` `label` `identity` `modelsOf` `creditsOf` `chatAs`。
**可选**：`configure` `warmup` `login` `loginLoopback` `probe` `catalogOf` `checkinStatusOf` `checkinClaimOf` `lastCheckinOf` `rotateDeviceIdOf` `logoutOf` `multiAccount`（默认 `true`）。

`loginLoopback()` 回答「登录回调是不是必须从浏览器所在机器的环回地址打进来」。Trae 返回 `{port, path}`（授权页只认环回，内网 IP 不跳），网关据此在登录任务的 SSE 事件里带上 `loopback`，由插件在本机开 TCP 转发；没实现它的通道（WorkBuddy / Qoder）事件里是 `null`，插件什么都不做。**随机端口时必须返回 `null`**——外部没法预告一个随机端口。

`warmup(account)` 在启动预热时对每个 `ready` 账号调一次，用来垫本地基线——Trae 的账本靠「请求前后读账号计数器做差」，没有基线的话重启后第一个请求记不到消耗。

`rotateDeviceIdOf(account)` 给这个账号换一套**设备身份**（目前只有 Trae 实现）。背景：上游按**设备**记签到（实测 `did_checked_in` 逐设备不同），而客户端一台机器只登一个号，所以一台机器上多个号不该共用一个设备号。`selfDeviceId` 因此从「机器级」改成「每账号一份」，新登录的号自动独立；已存在的账号靠这个动作换掉老的共用号。方法只返回要覆盖的字段（`{ selfDeviceId }`），路由层**合并**进凭据而不是整份替换。**它治不了 9074**——那个是上游活动瞬时爆满，与设备号无关。

`catalogOf(account)` 返回带 `lengths.options` 的上游原始目录，是上下文窗口下拉的**唯一档位来源**。目前 WorkBuddy 和 Trae 实现了（Qoder 没有）；没实现的通道在 `/api/models/catalog` 里 `lengths` 为 `null`，页面让用户自由填——**不是错误，是上游确实没给档位**。设置本身按 `<idPrefix>/<上游模型 id>` 存在 `data/config.json` 的 `modelSettings` 里（见 `shared/model-settings.ts`），账号不参与寻址。

所有账号级方法都收一个 `Account`——**凭据由账号对象注入，通道不碰磁盘**。这是 v2 相对 v1 最大的变化：通道退化成纯协议适配器，不知道「这个通道挂了几个号」，也就不会有选号逻辑；副作用是可测（给假账号就能跑）。

`idPrefix` 的校验：非空、全小写字母数字（不含 `-` 和 `/`）、**全局唯一**。撞车不会报错，只会让一批请求静默走错上游，所以注册表加载时拦。

`chatAs(account, request)` 返回 `ChatOutcome`：

```ts
type ChatOutcome =
  | { kind: 'json';   status: number; body: unknown }
  | { kind: 'stream'; status: number; headers: Record<string,string>; body: AsyncIterable<string> }
```

两种形态由**通道**决定（它看上游回的 content-type），路由层只负责按形态发响应。失败抛 `UpstreamError`。

`request.onUsage(usage)` 让通道在拿到用量时回调（流式是最后一个 chunk 之后）；记账在路由层，因为账本要记 `provider` 和 `account` 两段身份。

---

## 六、路由分成三层

这是**边界**，不是命名习惯：看一个路径就知道它归谁管、谁能调、返回什么。

| 层 | 前缀 | 谁在用 | 认证 | 返回 | 代码 |
|---|---|---|---|---|---|
| **前端 SPA** | 其余一切（`/` `/accounts` `/accounts/<id>` `/keys` `/models` `/settings` `/login` `/password` `/assets/*`） | 浏览器 | **不需要**（公开静态文件） | HTML / JS / CSS | `web/dist` + `app.ts` 的 `createSpaApp()` |
| **管理 API** | `/api/*` | SPA / 程序 / 脚本 / 面板 | Bearer key **或** Cookie | JSON | `routes/admin.ts` `routes/accounts.ts` `routes/keys.ts` `routes/json-actions.ts` |
| **OpenAI 兼容** | `/v1/*` | DSH | **只认** Bearer key | JSON / SSE | `routes/openai.ts` |

两条规矩：

- **`/v1/*` 只放协议本身**。网关私有的东西（credits、usage、models/settings、shutdown）
  一律去 `/api/*`——否则「哪条是 OpenAI 规范、哪条是我们加的」要逐个记，而这类记忆
  在半年后必然是错的。
- **写操作全部在 `/api/*`**。2026-11-13 之前还有「页面层 + 页面动作层」：8 个 SSR 页面、
  17 条表单 POST、服务端渲染的 SVG 图表。那两层随 SPA 转正一起删了，现在服务端
  **一个 HTML 页面都不出**。

**前端产物为什么可以公开**：它只是几个静态文件，不含任何数据。登录页必须在**没有任何
凭据**时也能加载，否则就是「想进门先给我门钥匙」。安全边界靠后面那两层的闸，不靠藏壳。

**未知路径怎么落**：`/api/*` 与 `/v1/*` 回 404 JSON（路径里带 `api/`、`v1/` 段也算，
所以 v1 时代的 `/workbuddy/v1/models` 一样 404）；其余回 SPA 壳，由前端路由显示 404 页。

`/api/models` 和 `/v1/models` 共用同一个函数（`modelListPayload()`），逐字节相同：
前者是给「设置页探测 / 脚本」的语义化路径，后者是协议入口。两者分开是为了让
「哪条给 DSH」一眼可见，不是为了让它们返回不同的东西。

---


## 七、请求链路（步骤清单）

图见 **§八 数据流**（含凭据刷新和记账时序）。这一节只留「按顺序该发生什么」，改代码时对着核对。

### 对话

```
1. authGate        Bearer / Cookie（`/api/login`、`/api/logout` 公开）
2. passwordGate    还没改过默认密码时全拒（`/api/login` `/api/logout` `/api/password` 豁免）
2b. bearerOnlyGate 只对 `/v1/*`：Cookie 在这里不算，必须是 Bearer key（见 §六 认证矩阵）
3. 解析 body       不是 JSON → 400
4. resolveModel    "wb-2/hy4free" → 通道 workbuddy + 账号 wb-2 + 模型 hy4free
                   拆不出 → 404，报错里给正确写法和现有账号
5. checkUsable     ready 放行；cooldown → 429；invalid / disabled → 503
6. body.model 改回裸 id，调 channel.chatAs(account, { body, signal, onUsage })
7. 按 outcome 发响应：json → c.json；stream → ReadableStream（pull 取一块，cancel 时调
   iterator.return() 停止读上游）
8. 记账            recordChatUsage(usage, model, effort, started, status, provider, account)
                   **不阻塞响应**：先把流关掉/把 JSON 发出去，再等用量（最多 20 秒兜底）。
                   用量（token）是**上游在响应里报的**，网关只记账、不自己数。
                   2026-11-13 起不再为积分做逐请求结算（Trae 那套请求前后做差已删），
                   积分改为只读官方余额——见 `private/docs/v3/overview-redesign.md`
9. 失败            UpstreamError 的 status 决定账号状态：401 → invalid，429 → cooldown
                   （带 Retry-After），其余不动。**不换号**
```

### 模型列表

```
GET /v1/models
  for 通道（`isListed(idPrefix)` 关掉就整段跳过）
    for 账号（按序号）
      channel.modelsOf(account)   失败就跳过这个账号（未登录/CLI 不在都很正常）
      filterModels(idPrefix, ...) 可见性，键不含账号
      toExternalModel(...)        id = `wb-2/hy4free`，name = `wb-2/Hy4 · 0.00x`
```

账号失效时模型**不消失**（`accountStatus` 变 `invalid`）：那份列表是 DSH 探测后固化进 profile 的，网关这边删了它也不会自动同步过去，反而让人以为「模型不见了」。只有删除账号才真的消失。

---

## 八、数据流

网关里跑着**四条互不相同的数据流**，别混着理解：只有第一条是「对话流量」，其余三条都是控制面/观测面。

### 8a. 对话流（唯一的大流量路径）

```
客户端                routes/openai.ts              core/                    channels/<x>/        上游
  │                         │                         │                          │               │
  │ POST /v1/chat/completions                         │                          │               │
  │ {"model":"wb-2/hy4free"}                          │                          │               │
  ├────────────────────────►│                         │                          │               │
  │                         │ resolveModel(raw)       │                          │               │
  │                         ├────────────────────────►│                          │               │
  │                         │  parseModelId: wb - 2 / hy4free                     │               │
  │                         │  channelByPrefix('wb') → workbuddy                 │               │
  │                         │  accountIdOf(2) → 'wb-2' → getAccount               │               │
  │                         │◄────────────────────────┤ {channel,account,modelId}│               │
  │                         │                         │                          │               │
  │                         │ 拆不出 → 404，不猜、不换号                          │               │
  │                         │                         │                          │               │
  │                         │ checkUsable(account)    │                          │               │
  │                         │  disabled/invalid → 503 │                          │               │
  │                         │  cooldown 未到点 → 429  │                          │               │
  │                         │                         │                          │               │
  │                         │ modelCooldownOf(账号,模型) → 429（只封这个模型）      │               │
  │                         │                         │                          │               │
  │                         │ body.model = 'hy4free'（剥掉账号段）                 │               │
  │                         │                         │                          │               │
  │                         │ chatAs(account, {body, signal, onUsage})            │               │
  │                         ├─────────────────────────┼─────────────────────────►│               │
  │                         │                         │   usableCredential()     │               │
  │                         │                         │   快过期→refresh→写回账号 │               │
  │                         │                         │◄─────────────────────────┤               │
  │                         │                         │                          │ 带凭据打上游   │
  │                         │                         ├──────────────────────────┼──────────────►│
  │                         │                         │                          │◄──────────────┤
  │                         │◄────────────────────────┼──────────────────────────┤ ChatOutcome   │
  │                         │                         │                          │ (json|stream) │
  │                         │                         │                          │               │
  │◄────────────────────────┤ 按 kind 发响应           │                          │               │
  │  SSE 或 JSON            │ 流式: pull/cancel 包装    │                          │               │
  │                         │                         │                          │               │
  │                         │ 记账（等用量就绪后，后台） │                          │               │
  │                         ├────────────────────────►│ recordChatUsage           │               │
  │                         │                         │ → usage_record 追加一行    │               │
  │                         │                         │                          │               │
  │  失败分支：              │ 429 → 只让账号保持 ready，不记任何状态（客户端自己退避）│               │
  │                         │ 401 → markInvalid（去管理台重登）                    │               │
  │                         │ credential_expired → markInvalid（本地就刷不出来）    │               │
  │                         │ credential_unavailable → 不改状态（网络/5xx，可重试）│               │
  │                         │ 502 → 不改状态（上游炸了，不记账号头上）              │               │
```

**三个容易被忽略的设计点**

1. **`body.model` 会被就地改写**：进来是 `wb-2/hy4free`，发给上游前剥成 `hy4free`。账号段和通道前缀是网关自己的寻址方式，上游不认识。
2. **记账是「等用量就绪」再写，但不拖住响应**：`settleLater()` 先让响应发出去，最多等 20 秒拿 usage。（Trae 不报单次积分，要等 3 秒读计数器做差。）
3. **客户端断开是 499 不是错误**：`cancel()` 里先 `iterator.return()` 让通道收尾（顺带 `onUsage`），再记 `499`。顺序反了会记成「用量未知」——2026-11-10 的「今日用量恒为 0」就是这个 bug。

### 8b. 模型清单流（`/v1/models` 与 `/api/models` 共用）

```
channels[]               accountsOf(channel)          channel.modelsOf(account)        上游
   │                            │                            │                          │
   │ for each channel           │                            │                          │
   ├───────────────────────────►│                            │                          │
   │  isListed(idPrefix)?       │                            │                          │
   │  否 → 整个通道跳过（总闸）  │                            │                          │
   │                            │ for each account           │                          │
   │                            ├───────────────────────────►│                          │
   │                            │                            ├─────────────────────────►│
   │                            │                            │◄─────────────────────────┤
   │                            │  抛错 → 跳过这个账号，不 5xx │                          │
   │                            │         （原因进 logs/）    │                          │
   │                            │◄───────────────────────────┤ ModelInfo[]              │
   │                            │                            │                          │
   │  filterModels(idPrefix, models)  ← 逐模型可见清单（键不含账号）                 │
   │  toExternalModel()               ← 加账号段 + 生成显示名                         │
   │◄───────────────────────────┤                            │                            │
   │ {object:'list', data:[{id:'wb-2/hy4free', name:'wb-2/Hy4 · 0.00x', …}]}          │
```

**两个筛子，语义不同**：`isListed`（通道总闸）和 `filterModels`（逐模型清单）。都在 `channel_visibility` 表里（v4 起进库），**改完立刻生效**，但**只影响列表、不影响对话**——被隐藏的模型仍可直接调用。

**每个账号是并发取的**（图上画成串行是为了好读）。这个接口被插件每 15 秒轮询一次，而 `modelsOf()` 可能打上游（WorkBuddy 的目录、Qoder 起 CLI）。串行 await 的话 N 个账号就是 N 倍等待，插件那边有超时——账号一多就会超时拿到空列表，表现成「模型全没了」，过一轮又回来。拼回去时仍按原顺序，因为那是用户看到的顺序。

**「关掉了」和「取不到」在响应里都表现为 0 个模型**，但语义相反。要分开只能看 `/api/health` 的 `listed` 字段。

### 8c. 凭据流（有效期判断 + 并发单飞）

```
任意调用方                 core/accounts.usableCredential()
   │                                  │
   ├─────────────────────────────────►│
   │                                  │ expiryOf(credential)：数字或 ISO 串都认
   │                                  │
   │               ┌──────────────────┴───────────────────┐
   │               ▼                                      ▼
   │     离过期还 > 10 分钟                        快过期 / forceRefresh
   │               │                                      │
   │               │                              有同账号刷新在飞？
   │               │                               ├─ 是 → 复用那个 promise
   │               │                               └─ 否 → 通道自己的 refresh()
   │               │                                      │
   │               │                                      ▼
   │               │                          updateAccount(id, {credential})
   │               │                          → 写回 account 表（upsert）
   │               │                                      │（下次重启不用重刷）
   │◄──────────────┴──────────────────────────────────────┘
   │  返回可用凭据
```

**为什么必须并发单飞**：上游往往把「刷新」做成一次性 —— 多个请求同时撞上过期各刷一次，先换出来的那个令牌立刻被后一次作废，于是前一个请求拿着刚失效的 token 401。

**401 重试要带 `forceRefresh: true`**：本地有效期还没到时不强制刷，读回来的还是同一枚被拒的令牌，等于白试一次。

### 8d. 登录 → 账号流

```
面板/脚本               routes/accounts.ts        core/login-tasks.ts        channels/<x>/login()      上游
   │                          │                          │                          │              │
   ├─ POST /accounts/login ──►│ startLogin(channel)      │                          │              │
   │                          ├─────────────────────────►│ 掐掉旧的未完成任务        │              │
   │                          │                          │ 建 task(running)         │              │
   │                          │                          │ publishEvent('login')    │              │
   │                          │                          │   → /api/events → 插件开隧道            │
   │                          │                          ├─────────────────────────►│              │
   │                          │                          │   onUrl(url) / onPrompt …│◄────────────►│
   │                          │                          │   （表单式登录时逐轮等） │              │
   │                          │                          │◄─────────────────────────┤ LoginResult  │
   │                          │                          │                          │              │
   │                          │                          │ materializeAccount():    │              │
   │                          │                          │  ① 上游 uid 已存在 → 复用 │              │
   │                          │                          │  ② multiAccount:false → 覆盖│            │
   │                          │                          │  ③ 否则新建（序号只增不减）│              │
   │                          │                          │ → account 表（upsert）    │              │
   │  轮询 GET …/login/:taskId│                          │                          │              │
   │◄─────────────────────────┤◄─────────────────────────┤ publicTask()             │              │
   │ running→done/error/cancelled                        │                          │              │
```

**取消后迟到的授权结果必须作废**（`task.state !== 'running'` 时直接 return）。否则用户点了「取消」，几分钟后浏览器那边完成授权，凭据会悄悄写回来，把它刚放弃的号复活。

### 8e. 一处没画进图里：插件侧的中介

笔记本上的 DSH 不直接读网关的 `data/`，它走两条路：

| 方向 | 通道 | 用途 |
|---|---|---|
| 插件 host → 网关 | `GET /api/models`（每 15 秒） | 把模型清单写进 profile 的 `models:` 段 |
| 网关 → 插件 | `GET /api/events`（SSE 长连接） | 登录开始/结束事件，插件据 `loopback.port` 开本机 TCP 转发 |

**为什么登录回调要插件转**：Trae 的授权页只肯把浏览器跳回 `127.0.0.1`，而网关在容器里、浏览器在笔记本上。所以网关只在环回监听回调端口，由插件在那台机器上把 `127.0.0.1:<port>` 转进来。SSE 是单向推送、断线即丢（没有重放）——插件没连着的时候用户本来也开不了登录。

---

## 九、关键不变量

| 不变量 | 为什么 |
|---|---|
| 模型 id 是唯一寻址方式，拆不出就 404 | 不猜通道、不跨账号兜底。`wb-9/x` 里的 9 号不存在就是 404，不会退到 1 号 |
| **绝不自动换号** | 指定的语义就是「这个号」。偷偷换到别的号会让账对不上（用户以为花的是 A 的额度，实际花了 B 的） |
| 账号状态只在一处改（`routes/openai.ts` → `core/accounts.ts`） | 通道看不到账号文件，它不该判断「这次失败要不要停用这个号」 |
| 账号序号只增不减 | 删掉 `wb-2` 不会让 `wb-3` 变成 `wb-2`，否则账本和 DSH 里存的模型 id 全部指向错的账号 |
| 可见性的键是 `idPrefix` + 模型 id，不含账号 | 隐藏「示例账号这个模型」不该对每个号各勾一次；加一个号也不用重勾 |
| 界面不认具体通道 | 禁止通道清单、按通道分支的地址、内置 `PROVIDERS`。地址用 `/api/health` 回出来的 `idPrefix` 拼 |
| 元数据只有一份 | `id` / `idPrefix` / `label` / `identity` 在通道对象上声明；`/api/health` 和 `/api/accounts` 回出去，别处读 |
| 版本号必须由通道声明且非空 | 上游拿它当客户端门禁，写错只回一句「客户端太旧」或 401，看起来像签名问题 |
| `/v1/models` 取不到就跳过，不 5xx | 未登录、CLI 不在、上游拒绝都是常态；空列表才是准确事实，原因写 `data/logs/` |
| 「通道关掉了」和「取不到」必须能分开 | 两者在 `/v1/models` 上都表现为 0 个模型，但语义相反。状态在 `/api/health` 的 `listed` 字段 |
| `/api/health` 只读本地状态，不发网络请求 | 它会被人反复轮询；每次去打上游等于把限流额度花在读健康上。验活走 `POST /api/accounts/<id>/verify` |
| 改密码不换 profile 里的凭据 | 改密只是「人进管理台」的凭据；API key 独立存在，改密码不该让 DSH 掉线 |

---

## 十、认证

两类凭据，按调用方选，**互相独立**（改密码不影响 key，吊销 key 也不影响登录）：

| 调用方 | 凭据 | 落在哪 |
|---|---|---|
| 浏览器页面 | 会话 Cookie（`POST /login` 种下，12 小时） | 内存 Map，重启即失效 |
| 程序（DSH、脚本、别的机器） | `Authorization: Bearer sk-…` | `api_key` 表，只存 `salt` + `hash`（scrypt，不可逆） |

默认 `admin/admin`，**改密之前除 `/login` `/password` `/logout` 外一律拒绝**（页面 302、API 401/403）。

### API key

- 明文 `sk-` + 48 位字母数字（51 字符，**和 OpenAI 的 key 同形**）。**明文不落库**（2026-11-22 起 `secret` 列已物理删除），只在 `POST /api/keys` 的响应里出现一次——`/keys` 列表里没有「查看」按钮，因为**真的取不回来**，不是藏起来。另存前 12 个字符作为前缀，让列表上能分清谁是谁。
- **校验结果**在内存里存快照（键是 `sha256(secret)`，不是明文）：命中直接放行、跳过单次 61ms 的 scrypt；TTL 默认 1 天、设置页可改。**不能预热**——`sha256(secret)` 需要 secret 本身，而库里只有 `scrypt(secret, salt)`，两者不可互推，所以每个 key 进程内第一次请求必然付一次 scrypt。
- 校验先用前缀筛候选，命中后常量时间比对明文；老记录（升级前建的、只有 `salt`+`hash`）回落到 scrypt。两条路径并存是为了升级后老 key 继续可用。
- 验证通过的 secret 在内存里缓存 5 分钟，避免每个请求都重新比对。
- 停用立刻生效（停用时清缓存），删除不可撤销，两者都在 `/keys` 页上操作。
- `accountScope` 字段留着不实现（「这把 key 只能用 wb-1」，见 private/docs/v2 §14 未决 6）。
- **取舍**：`api_key` 表泄露即等同 key 泄露。但整个 `data/` 目录已 gitignore、Windows 上由 `data-permissions.ts` 收紧 ACL，而且上游凭据（`account.credential`）同样是明文——没有突破这个目录既有的安全边界。

### 旧 token 和 Basic 都已删除

v1 在 `gateway.json` 里存过一段明文 `token` 当机器凭据，还认过 `Authorization: Basic`。两个都删了，**没留兼容分支**：

- 机器凭据只有 `api_key` 表一处。
- `loadCredential()` 只取 `username` / `salt` / `hash` / `mustChangePassword` 四个字段；v1 的明文 `token` 在两张表里都没有对应的列，迁库时就已经丢掉了。
- 代价是升级后旧 profile 立刻 401——去 `/login` 登录，在 `/keys` 建一把新的就行。开发阶段不值得为这一步写兼容。

### 认证矩阵

| 路径 | 认什么 | 闸 |
|---|---|---|
| `/v1/*` | **只认 API key（Bearer）**，不认 Cookie | `authGate` → `passwordGate` → `bearerOnlyGate` |
| `/api/*` `/api/health` | API key（Bearer）**或**会话 Cookie | `authGate` → `passwordGate` |
| `/login` `/logout` | 公开 | 无 |
| 其余页面 | 会话 Cookie（没凭据时 302 到 `/login`） | `authGate` → `passwordGate` |

**`/v1/*` 那道额外的 `bearerOnlyGate` 是有意收紧的**：`authGate` 是通配的，两种凭据都认（浏览器要用 Cookie 打开管理台），于是「只认 key」这条此前只是文档里的一句话——在浏览器里登录过的人，地址栏敲 `/v1/models` 也能拿到数据。菜单面上没洞（能登录的人本来就有全部权限），但边界必须能被代码表达，否则下次有人加 `/v1/*` 端点时会以为这里天然是「程序专用」。

顺带一个实际效果：容器部署时 `Host` 闸是关的（`loopbackGateActive()` 跟监听地址走，绑 `0.0.0.0` 时恒 false），而浏览器里的跨站请求会**自动带 Cookie**（`SameSite=Lax` 挡不住顶层 GET 导航），key 不会。收掉 Cookie 之后这条路只剩「显式带 key」一种。回归测试在 `test/openai-route.mjs` §2b。

新增页面或接口时想一遍：它该不该在闸门后面；是给人看的就加进 `isPagePath()`（否则未登录时会回一屏 JSON 而不是登录页）；是协议入口就放进 `/v1/*`，不要往那里加管理端点。
