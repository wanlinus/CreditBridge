# API 契约

这份是**形状**：请求体、响应体、状态码、错误信封。路径分层的边界和「为什么这么分」在
[`ARCHITECTURE.md`](ARCHITECTURE.md) §六；怎么起服务、怎么排错在 [`README.md`](README.md)。
下面所有样例都是从跑着的网关里实抓的（账号 `wb-1` / `tr-1`），不是手写的。

---

## 通用约定

### 三层与认证

| 层 | 前缀 | 认证 | 返回 |
|---|---|---|---|
| 前端 SPA | 其余一切：`/` `/accounts` `/accounts/<id>` `/keys` `/models` `/checkin` `/settings` `/login` `/password` `/assets/*` | **不需要**（公开静态文件） | HTML / JS / CSS |
| 管理 API | `/api/*`（`/api/events` 是 SSE 长连接） | `Authorization: Bearer sk-…` **或** Cookie | JSON / SSE |
| OpenAI 兼容 | `/v1/*` | **只认** `Authorization: Bearer sk-…` | JSON / SSE |

`/v1/*` 不接受 Cookie：那一层的调用方是程序，用会话走它说明接错了。**这一条是代码强制的**（`auth/middleware.ts` 的 `bearerOnlyGate`，只挂在 `/v1/*` 上），不是文档约定——带 Cookie 打 `/v1/models` 会拿到 401。`/api/*` 两种都认。

**前端产物公开是必须的**：登录页在还没有任何凭据时就要能加载。它只是几个静态文件，不含数据。
2026-11-13 之前还有「页面层」和「页面动作层」（SSR 页面 + 表单 POST），那两层已经删干净，
所以本文件里**不存在页面路径的条目**——凡是路径都是 `/api/*` 或 `/v1/*`。


### 错误信封

**所有层统一**（v1 的 `{"ok":false,"error":"字符串"}` 在 E 阶段删掉了）：

```json
{ "error": { "message": "人话原因", "type": "gateway_error", "code": "model_not_found" } }
```

| 字段 | 说明 |
|---|---|
| `message` | 给人看的，**必须能直接行动**（「去 /accounts 重新登录」而不是「unauthorized」） |
| `type` | `unauthorized` / `forbidden` / `not_found` / `bad_request` / `gateway_error` / `upstream_error` |
| `code` | 可选，机器可读的细分（`model_not_found`、`account_invalid`、`workbuddy_401`…） |

### 认证失败

| 场景 | 状态 | `type` |
|---|---|---|
| 没带凭据 / key 不对 / key 被停用 | 401 | `unauthorized` |
| 还没改默认密码 | 403 | （见下） |
| key 停用或删除后立刻失效 | 401 | `unauthorized` |

```json
{ "error": { "message": "未登录：先打开 /login，或在 Authorization 里带 Bearer key", "type": "unauthorized" } }
```

**没改默认密码时**（`mustChangePassword`），除 `/login` `/password` `/logout` 外一律拒绝：

```json
{ "error": { "message": "还没改过默认密码：先打开 /password 设置新密码，之后再访问接口", "type": "password_change_required" } }
```

浏览器打开的路径（`/`、`/accounts/*`、`/keys`、`/models`、`/settings`）在没凭据时是 **302 → `/login`**，
不是 401 JSON；这些路径 404 时也是 HTML 页而不是 JSON。

### 时间

所有时间戳都是**毫秒整数**（`createdAt` / `lastUsedAt` / `expireAt`）。
账本的 `ts` 也是毫秒——它存在 `usage_record` 表里，形状和 API 一致。

---

## 一、OpenAI 兼容层 `/v1/*`

### `GET /v1/models`

```json
{
  "object": "list",
  "data": [
    {
      "id": "wb-1/fast-model",
      "object": "model",
      "name": "wb-1/快速 · 0.15x",
      "context_length": 300000,
      "max_output_tokens": 48000,
      "reasoning": true,
      "input": ["text", "image"],
      "owned_by": "workbuddy",
      "accountStatus": "ready"
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `id` | `<idPrefix>-<序号>/<上游模型 id>`，**账号是身份的一部分**（决定花谁的钱） |
| `name` | `<账号 id>/<模型本名> · <倍率>`，从上游 name 按最后一个 ` · ` 拆出来。**不用 label**：label 是给人改的别名，改了不该让 DSH 里的名字跟着变 |
| `reasoning` / `input` | 非标准，给 DSH 生成 `reasoningEfforts` / `input` 用 |
| `reasoningEfforts` / `defaultReasoningEffort` | 非标准、可选。上游**实际支持**的档位名（如 `["none","low","medium","high","xhigh"]`）和默认档。只有通道能逐个模型拿到档位表时才报（目前是 Loomy 的 `reasoning_efforts` / `default_reasoning_effort`）；缺省表示「沿用客户端默认档位表」。**别补一套标准档**——写了上游不认的档，请求不会报错，只会静默按默认档跑 |
| `owned_by` | 通道 id（不是 idPrefix） |
| `accountStatus` | 非标准：`ready` / `invalid` / `disabled`。账号失效时 id **仍在**列表里，只有删账号才消失 |

取不到目录的账号被**跳过**（未登录、CLI 没装、上游拒绝），不 5xx。

### `POST /v1/chat/completions`

请求体是标准 OpenAI Chat Completions，唯一的区别在 `model`：

```json
{
  "model": "tr-1/glm-5.3-flash",
  "stream": true,
  "messages": [{ "role": "user", "content": "只回复两个字：收到" }]
}
```

**`model` 必须带账号段**。网关拆成「通道 + 账号 + 上游裸 id」，把裸 id 写进发给上游的
`body.model`。拆不出、账号不存在、上游没这个模型 → 404。

#### 流式（`stream: true`，默认）

`Content-Type: text/event-stream`，帧序列固定：

```
data: {"id":"chatcmpl-…","object":"chat.completion.chunk","created":…,"model":"glm-5.3-flash","choices":[{"index":0,"delta":{"reasoning_content":"用户"},"finish_reason":null}]}

data: {"id":"chatcmpl-…","object":"chat.completion.chunk","created":…,"model":"glm-5.3-flash","choices":[{"index":0,"delta":{"content":"收到"},"finish_reason":null}]}

data: {"id":"chatcmpl-…","object":"chat.completion.chunk","created":…,"model":"glm-5.3-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: {"id":"chatcmpl-…","object":"chat.completion.chunk","created":…,"model":"glm-5.3-flash","choices":[],"usage":{"prompt_tokens":52,"completion_tokens":32,"total_tokens":84}}

data: [DONE]
```

- 四段：`delta` 若干 → `finish_reason` 帧 → `choices: []` 只有 `usage` 的帧 → 哨兵。
- **响应里的 `model` 是上游裸 id**（`glm-5.3-flash`），不是请求里的 `tr-1/glm-5.3-flash`。
  网关是流式透传，不改写通道写出的每一帧；DSH 不依赖这个字段，但按 `model` 做统计的
  客户端要知道这件事。
- 流已经开始之后上游出错：只能往流里写一帧 `{"error":{…}}` 再断，**状态码改不了**（已经是 200）。

#### 非流式（`stream: false`）

```json
{
  "id": "chatcmpl-…",
  "object": "chat.completion",
  "created": 1794292175,
  "model": "glm-5.3-flash",
  "choices": [
    { "index": 0, "message": { "role": "assistant", "content": "收到" }, "finish_reason": "stop" }
  ],
  "usage": { "prompt_tokens": 52, "completion_tokens": 32, "total_tokens": 84 }
}
```

Trae 只肯流式返回，非流式是网关在本地聚合出来的。

#### 错误

| 情况 | 状态 | `code` |
|---|---|---|
| 模型 id 形状不对 / 账号不存在 / 通道不认识 | 404 | `model_not_found` |
| 账号 `invalid` / `disabled` | 503 | `account_invalid` / `account_disabled` |
| 上游 4xx | 原样 | `trae_401`、`workbuddy_429`… |
| 上游 5xx / 传输失败 | 502 | `<通道>_transport` |
| **本地凭据刷不出来** | 502 | `credential_expired`（永久）/ `credential_unavailable`（暂时） |

**账号状态只在这里改**：

| 触发 | 改成 | 说明 |
|---|---|---|
| 上游 401 | `invalid` | 凭据被上游拒了 |
| 上游 429 | **不改账号状态** | 上游限流按模型，恢复时间网关猜不准，原样回给客户端自己退避 |
| `credential_expired` | `invalid` | refreshToken 过期/被拒，或通道压根没有刷新机制（Loomy）。刷多少次都是同一结果 |
| `credential_unavailable` | **不动** | 网络断了、上游 5xx。一次抖动不该把号封成失效 |
| 其余 4xx / 5xx | 不动 | 上游在说这次请求不行，不该记到账号头上 |

`credential_expired` 和 `credential_unavailable` 都是 502（沿用「凭据不可用」这一档），**靠 `code` 区分**而不是状态码——状态码要留给「回给客户端的 HTTP 语义」。实现见 `src/shared/credential-error.ts`。

这个区分不是洁癖：早先两者都退化成普通 502，而 502 不改状态，于是 refreshToken 过期的号**永远显示「就绪」**——用户在 DSH 里看到「模型都在列表里、点哪个都报错」，管理台上却没有任何「请重新登录」的提示。

**绝不换号**——指定的语义就是「这个号」。

---

## 二、管理 API `/api/*`

### `GET /api/channels`

通道的**外观**清单：名字 + 图标。给插件（cb-dsh）画徽标用。

```json
{
  "channels": [
    { "id": "workbuddy", "label": "WorkBuddy", "idPrefix": "wb", "letter": "W", "icon": "data:image/png;base64,iVBORw0…" },
    { "id": "loomy", "label": "Loomy", "idPrefix": "lo", "letter": "L", "icon": "data:image/png;base64,iVBORw0…" }
  ]
}
```

- `icon` 是 **data URI**（读 `src/channels/<id>/icon.png`，64×64），不是 URL：插件跑在
  `dsh-app://` 下，`<img>` 能不能直连网关取决于 `img-src`，那个没有验证过；data URI 一直是通的。
- 没有图标的通道 `icon` 为 `null`，客户端用 `letter`（`label` 首字符）兜底。
- 和 `/api/health` 的分工：那个回答「还活着吗」（一秒都不能缓存），这个回答「长什么样」
  （`Cache-Control: private, max-age=300`）。**图标不挂在徽标接口上**——那个 60 秒轮询一次，
  每轮白发十几 KB 不值。

### `GET /api/health`

**只读本地状态，不发网络请求**。要认证，所以它不是无认证探针。

```json
{
  "ok": true,
  "gateway": "up",
  "version": "0.4.1",
  "startedAt": "2026-11-10T11:04:21.298Z",
  "modelIdFormat": "<idPrefix>-<seq>/<model>",
  "channels": {
    "workbuddy": {
      "id": "workbuddy",
      "label": "WorkBuddy",
      "idPrefix": "wb",
      "identity": { "clientVersion": "5.9.3", "channelVersion": "2.165.0", "ideVersion": "5.9.3" },
      "listed": true,
      "multiAccount": true,
      "canLogin": true,
      "accounts": ["wb-1"]
    },
    "qoder": { "idPrefix": "qd", "multiAccount": true, "accounts": [] }
  },
  "accounts": [
    {
      "id": "wb-1",
      "channelId": "workbuddy",
      "channelLabel": "WorkBuddy",
      "idPrefix": "wb",
      "label": "示例账号",
      "status": "ready",
      "statusMessage": null,
      "uid": "00000000-…",
      "username": "示例账号",
      "hasCredential": true,
      "createdAt": 1794292127304
    }
  ]
}
```

- `channels[id].listed` 是模型列表总闸（`false` = 这个通道的模型不进 `/v1/models`）。
- `channels[id].multiAccount` 为 `false` 表示只能挂一个号。目前四个通道都是 `true`——Qoder 曾在 2026-11-22 之前是 `false`（对话依赖常驻 CLI 的机器级登录态），CLI 移除后已放开。
- `identity` 是报给上游的版本串——排查「上游说客户端太旧」时看这里。

### `GET /api/models`

和 `GET /v1/models` **逐字节相同**（共用 `modelListPayload()`）。给设置页探测和脚本用。

### `GET /api/models/visibility`

```json
{ "channels": { "wb": { "listed": true, "models": null }, "tr": { "listed": true, "models": null }, "qd": { "listed": true, "models": null }, "lo": { "listed": true, "models": null } } }
```

`models: null` = 全部显示；数组 = 只显示列出的那些（顺序即列表顺序）。键是**短前缀**，
不含账号——隐藏「Hy4 这个模型」不该对每个号各勾一次。

### `GET /api/accounts`

```json
{
  "accounts": [
    {
      "id": "wb-1",
      "channelId": "workbuddy",
      "channelLabel": "WorkBuddy",
      "idPrefix": "wb",
      "seq": 1,
      "label": "示例账号",
      "status": "ready",
      "statusMessage": null,
      "profile": { "uid": "00000000-…", "username": "示例账号", "domain": "www.workbuddy.cn" },
      "createdAt": 1794292127304,
      "totalRemain": 1550,
      "usedTotal": 937,
      "limitTotal": 2487,
      "prevRemain": 1600,
      "prevAt": 1794550200000,
      "creditsAt": 1794550260000,
      "todayTokens": 102600075,
      "totalTokens": 482260032
    }
  ],
  "channels": [
    { "id": "workbuddy", "label": "WorkBuddy", "idPrefix": "wb", "multiAccount": true, "canLogin": true, "canLogout": false, "canVerify": true, "reportsTokens": true, "accounts": ["wb-1"] }
  ]
}
```

**两类字段，口径完全不同，不可混用**：

| 字段 | 来源 | 能相加吗 |
|---|---|---|
| `totalRemain` / `usedTotal` / `limitTotal` | 各通道**官方**接口 | **不能**——单位与重置规则各不相同 |
| `todayTokens` / `totalTokens` | 网关账本（token 取上游 `usage` 帧） | 能（客观计数） |

三个积分字段都可能是 `null`，含义是「**该通道不提供**」而不是 0：

- `limitTotal`：Loomy 没有「总额度」概念（每日重置、不用作废）→ 恒为 `null`
- `usedTotal`：上游没报就没有
- `totalRemain`：这次没拉到（凭据坏了 / 上游挂了）

`prevRemain` + `prevAt` 用来显示「较上次 ±X」，是**两次余额快照之差**，不是逐请求结算。

`reportsTokens: false` 的通道（目前只有 Qoder）**上游根本不报 token**，它名下账号的
`todayTokens` / `totalTokens` 恒为 0 —— 界面必须显示 `—` 并说明，用 0 会被读成
「用过但没消耗」。

`totalRemain` / `usedTotal` / `todayTokens` 是**并发拉出来的**：余额来自上游（可能失败 →
`null`），用量来自账本。慢或坏的那几个不会拖住整页。

### `POST /api/accounts/:channel/login`

起一次登录任务（不 await，最长 5 分钟）：

```json
{ "ok": true, "task": { "taskId": "1794308660924", "channelId": "workbuddy", "state": "running", "url": null, "message": null, "startedAt": 1794308660924, "finishedAt": null, "accountId": null } }
```

- 同一通道再点一次会**掐掉上一次**（`AbortController`）。
- `url` 在通道拿到授权地址后填上（可能要等一两秒，调用方轮询即可）。

### `GET /api/accounts/:channel/login/:taskId`

```json
{ "taskId": "1794308660924", "channelId": "workbuddy", "state": "done", "url": "https://www.workbuddy.cn/login?...", "message": null, "startedAt": 1794308660924, "finishedAt": 1794308663000, "accountId": "wb-1" }
```

`state`：`running` / `done` / `error` / `cancelled`。任务只在内存里留最近 20 个。

`cancelled` 是**用户主动放弃**，和 `error` 分开：页面话术不同，而且取消之后迟到的授权结果必须作废（否则点完取消、几分钟后浏览器那边登完了，凭据会悄悄写回去）。

### `DELETE /api/accounts/:channel/login/:taskId`（取消登录）

**幂等**：任务已经结束（或压根不存在）也回 200——用户连点两下不该看到报错。

```json
{ "ok": true, "cancelled": true, "existed": true }
```

`existed` 只表示「网关里有没有这个任务」，`cancelled` 表示「这次调用有没有真的把它停掉」。
另有 `DELETE /api/accounts/:channel/login`：取消该通道所有在跑的登录，回 `{ ok, cancelled: 2 }`。


### `POST /api/accounts/:id/verify`

真打一次上游验凭据（**会消耗一次请求**，别放进轮询）：

```json
{ "ok": true, "profile": { "uid": "00000000-…", "username": "示例账号", "domain": "www.workbuddy.cn" } }
```

成功会把 `profile` 写回账号、状态置回 `ready`。

### `PATCH /api/accounts/:id`

```json
{ "label": "新名字", "status": "disabled" }
```

- `label`：非空才生效（避免把名字改没）。
- `status` 只接受 `disabled` / `ready`。`invalid` 是网关根据上游反应写的，
  外部指定会 400——手动设一个「凭据失效」只会让人以为真坏了。

### `DELETE /api/accounts/:id`

```json
{ "ok": true, "removed": "wb-2" }
```

删账号连凭据一起删；它名下的模型 id 从下次 `/v1/models` 起消失。**不可撤销**。

### `GET /api/accounts/:id/credits`

```json
{
  "provider": "workbuddy",
  "supported": true,
  "totalRemain": 1550,
  "packages": [{ "name": "CodeBuddy个人版国内运营裂变包", "limit": 500, "used": 500, "expireAt": 1794054125000 }],
  "account": { "id": "wb-1", "label": "示例账号", "status": "ready", "statusMessage": null, "uid": "00000000-…", "username": "示例账号", "tokenExpiresAt": "2026-12-09T13:03:36.206Z" },
  "label": "WorkBuddy",
  "idPrefix": "wb",
  "checkin": { "date": "2026-11-10", "status": "already", "message": "今天已签到，请明天再来", "at": 1794292142807 },
  "loggedIn": true,
  "canLogin": true,
  "canLogout": false
}
```

- `totalRemain` 是徽标和面板唯一读的数字。
- `packages` 已经归一成 `{name, limit, used, expireAt}`（三家上游字段名各不相同，归一化
  是通道的责任）。**`limit` 可以是 `null`**——Loomy 没有「总额度」这个概念（每日重置、
  不用作废），硬凑成「剩余 + 已用」会得到一个看着自洽实际错误的数字。
- **失败仍回 200**：`{"supported": false, "error": "…", …}`，让界面显示「—」而不是整块崩掉。

### `POST /api/accounts/:id/credits` · `POST /api/channels/:id/credits`

**手动「刷新积分」**：绕过网关那 30 秒的余额缓存，直接问上游。账号级和通道级返回体同构：

```json
{
  "credits": {
    "wb-1": { "totalRemain": 113, "usedTotal": 4937, "limitTotal": 5050,
              "prevRemain": 120, "prevAt": 1794583000000, "creditsAt": 1794583391790,
              "error": null }
  }
}
```

- 字段名和 `GET /api/accounts` 每一行**一一对应**，界面拿到后按 id 覆盖那几行即可，不用整页重拉
  （重拉会打断正展开的「更多」菜单）。
- `GET /api/accounts` 的余额带 30 秒 TTL（挡密集轮询）。这两个 POST 的存在是因为**手动点击的
  语义恰恰是「我不信缓存」**；如果绕过缓存却不清缓存，下一次列表拉取又会把旧值盖回来。
- **上游没给数时 `error` 有文案**（`error: null` 才是成功）。点按钮的人必须知道为什么数字没变——
  静默留个「—」会被当成按钮坏了。
- 通道不存在 / 账号不存在 → 404，绝不掉进真上游。

### `GET /api/usage/hourly`

某一天按 **24 小时**拆开。概览页（和账号详情页）的趋势图上点一根柱子就进到这里。

```
GET /api/usage/hourly?date=2026-11-13[&account=wb-1][&provider=workbuddy]
```

```json
{
  "date": "2026-11-13",
  "weekday": 5,
  "isPeakDay": true,
  "hours": [
    { "hour": 0, "requests": 12, "tokens": 1208400, "promptTokens": 1200000,
      "completionTokens": 8400, "cachedTokens": 1100000, "credits": 0,
      "cost": { "cny": 0.12, "peakCny": 0, "offPeakCny": 0.12, "…": 0 }, "peak": false },
    { "hour": 9, "requests": 42, "tokens": 31042627, "…": 0,
      "cost": { "cny": 3.4, "peakCny": 3.4, "offPeakCny": 0 }, "peak": true }
  ],
  "totals": { "requests": 1204, "tokens": 511394399, "…": 0,
              "cost": { "cny": 105.0856, "peakCny": 21.4296, "offPeakCny": 83.656 } },
  "generatedAt": "2026-11-13T14:25:00.000Z"
}
```

**几条硬约定**：

- `hours` **恒 24 项**（缺的补 0，含今天还没到的小时）。前端不该自己补齐——补的规则
  一旦两边不一致，「第 9 根柱子」到底是不是 9 点就说不清了。
- **`cost` 由网关算，客户端不算**。价目表和峰谷规则只在
  `src/shared/deepseek-pricing.ts`；前端复制一份必然两边不一致，而且不会有任何报错。
  费用是**逐条记录按各自的 `ts` 判峰谷**再汇总的，所以 12:00 / 18:00 边界不会错档。
- `peak` 是「这一小时在不在官方峰时段」（工作日 9-12、14-18）。它只用来上色，
  **不要拿它反推费用**——费用看 `cost`。
- **`hours[].cachedTokens` 是「推算缓存」，不是上游原值**：上游报了就照原值，不报缓存的
  通道（Trae）按**这一天**其他通道的实测加权命中率折算；`assumedCachedTokens` 单独报出
  其中多少是折算的。所以 `promptTokens − cachedTokens` **不再等于「未命中输入」**，
  界面标题写的是「推算缓存」。原值在 `GET /api/usage` 的 `today.cachedTokens`。
- 折算比例跟着**这一天**走，不是"今天"的率——拿今天的率去折算历史某天是错的。
- **`date` 只接受 `YYYY-MM-DD`，且不能是未来**：格式不对、`2026-02-30` 这种不存在的
  日期、未来日期 → **400**（不会 500）。`2026-02-30` 必须靠回读比对挡住，`new Date()`
  会把它静默进位成 3 月 2 日。
- `totals` 与 `GET /api/usage` 里 `today` 的数字**必须一致**（同一天、同一筛选条件）——
  这条是「两个入口同一个数」的判据，对不上就是有 bug。

### `GET /api/accounts/:id/usage`

**主口径是 token，不是积分**（token 是上游在响应 `usage` 帧里报的数，网关只做记账汇总）：

```json
{
  "window": { "days": 30, "since": 1791610265044 },
  "totals": {
    "requests": 3, "tokens": 84, "promptTokens": 52, "completionTokens": 32,
    "cachedTokens": 0, "reasoningTokens": 0, "credits": 0.02,
    "statusCounts": { "200": 3 }
  },
  "today": {
    "requests": 3, "tokens": 84, "promptTokens": 52, "completionTokens": 32,
    "cachedTokens": 0, "reasoningTokens": 0, "credits": 0.02,
    "statusCounts": { "200": 3 }, "medianDurationMs": 4742
  },
  "daily": [{
    "date": "2026-11-10", "tokens": 84, "requests": 3, "credits": 0.02,
    "byModel": { "glm-5.3-flash": { "tokens": 84, "completionTokens": 32, "requests": 3, "credits": 0.02 } },
    "byAccount": { "tr-1": { "tokens": 84, "completionTokens": 32, "requests": 3, "credits": 0.02 } },
    "byProvider": { "trae": { "tokens": 84, "completionTokens": 32, "requests": 3, "credits": 0.02 } }
  }],
  "byModel": [{ "model": "glm-5.3-flash", "requests": 3, "tokens": 84, "promptTokens": 52, "completionTokens": 32, "credits": 0.02, "creditsPerKToken": 0.24 }],
  "byAccount": [{ "account": "tr-1", "requests": 3, "tokens": 84, "promptTokens": 52, "completionTokens": 32, "credits": 0.02 }],
  "todayByAccount": [{ "account": "tr-1", "requests": 3, "tokens": 84, "promptTokens": 52, "completionTokens": 32, "credits": 0.02 }],
  "recent": [{ "ts": 1794292265044, "provider": "trae", "account": "tr-1", "model": "glm-5.3-flash", "credit": null, "promptTokens": 52, "completionTokens": 32, "durationMs": 4742, "status": 200 }],
  "generatedAt": "2026-11-10T11:05:00.000Z"
}
```

**几条必须遵守的口径**：

- **`totals` / `byModel` / `byAccount` 覆盖「近 30 个本地日历日」，不是全史**（`window`
  字段把天数报给界面，**不要在客户端写死 30**）。原因是账本一年 60 万行，全表 `SUM`
  会随账本一起变慢；而「最近花了多少」30 天足够。`today` / `todayByAccount` 只算今天。
- `tokens` = `promptTokens + completionTokens`，**缓存和推理是明细、不是增量**。
  `cachedTokens` 是**上游原值**，`cached` 是 `prompt` 的子集——**绝不能** `prompt + cached`。
  **缓存命中率别拿这两个相除**：Trae 从不报缓存，会把率从 99% 拖到 84%。卡片读
  `today.cacheHit.rate`（排除不报缓存的通道），见下面那段。
- `daily` 固定 14 天（含今天，缺的补 0）。子桶同时带 `tokens` 和 `completionTokens`——
  后者单独留一份，因为趋势图要能切到「仅输出」（输入输出差三个数量级）。
- `statusCounts` 让前端算成功率。**算的时候必须排除 `499`**（客户端主动断开，不是故障），
  否则会把正常行为报成故障——实测某天 282 条里 189 条是 499，不排除时成功率只有 31%。
- `medianDurationMs` 是**中位数不是平均值**：上游偶发一次几百秒的卡顿会把均值拉垮。
- `cost` 是**按 DeepSeek 官方价目折合的人民币参照值，不是账单**（这些 token 花在
  WorkBuddy/Trae/Qoder/Loomy 上，不走 DeepSeek 的 API）。它是**逐条记录按各自的 `ts`
  分峰谷计价后汇总**的（官方高峰价是空闲价的 2 倍），`peakCny` / `offPeakCny` 给出
  拆分。价目与规则见 `src/shared/deepseek-pricing.ts`。
- **`cost.assumedCachedTokens` 是「推算」出来的缓存命中量**：有通道（目前是 Trae）不报
  缓存明细，网关按**同窗口内其他通道的实测加权命中率**推算。**界面必须显示它**——不标出来
  的推算就是假数据。上游报了正数时真值优先，这一项就不会包含那条记录。
  注意它只影响 `cost`，`totals.cachedTokens` 永远是上游原值。
- **`today.cacheHit` 是缓存命中率的口径**（这里最容易算错）：
  - `rate`：**排除**不报缓存的通道之后的实测加权率，卡片显示这个；
  - `measuredRate`：旧口径（含那些通道、按 0 计），只作对照；
  - `effectiveCachedTokens`：上游原值 + 推算量，卡片上「省下 X」读这个；
  - `estimated`：`{cachedTokens, promptTokens, rate, providers}`，谁是推算的、按多少推的。
  没有可对比数据时 `rate` 为 `null`，推算回落到 98%。
- `credits` / `creditsPerKToken` 仍在，但只是**附属信息**——它不是每个通道都有
  （账本里覆盖率 58%，Loomy 只有 1%）。`creditsPerKToken` 也不再是「相对倍率」，
  倍率反推已删（上游自己就有倍率）。
- `cachedTokens` 有 84% 的历史行是 `null`（老版本没记这个字段），所以命中率是**近期口径**。

### `GET /api/accounts/:id/badge`

输入框右边那个徽标要显示的东西：主数字 + 今日用量文案。**文案由网关算**——「显示积分
还是 token」取决于通道的计费方式，那是通道语义，不该让前端每加一个通道改一次。

```json
{
  "channel": "loomy",
  "title": "Loomy · 示例账号",
  "amount": "1234",
  "today": "今日 0.5",
  "note": null
}
```

| 字段 | 含义 |
|---|---|
| `channel` | 通道 id。客户端用它去 `/api/channels` 的缓存里查图标 |
| `title` | 「通道 · 账号」，用作图标 `alt` 和悬停提示 |
| `amount` | 余额；取不到是 `—`；通道自述没有余额接口是 `已连接` |
| `today` | 今日用量：有积分显示积分，积分为 0 但有 token 显示 token，否则显示请求次数；都没有是空串 |
| `note` | 取不到余额的原因，正常为 `null` |

和 `/api/accounts/:id/credits` 的分工：那个是**余额的完整快照**（套餐明细、账号信息、
签到状态），给面板和账号页；这个是**两个字符串**，给 14px 高的地方，每 60 秒轮询一次，
所以必须轻（`Cache-Control: no-store`，余额是实时数字）。

#### `recent` 里的 `status`

| 值 | 含义 |
|---|---|
| `200` | 正常结束（流读完 / JSON 返回） |
| `499` | **客户端在流读完前断开**（nginx 的 `client closed request` 约定）：用户点停止、切模型、或客户端放弃等待。**不是服务端错误**，用量照记 |
| `429` | 上游按模型限流。**网关不拦、不记冷却**，原样转发给客户端自己退避（2026-11-13 删掉了模型级冷却，理由见 `cb-gateway/README.md`） |
| `4xx` / `5xx` | 上游或网关的真实失败。`502` 是上游传输层挂了 |

### `GET /api/accounts/:id/checkin` / `POST /api/accounts/:id/checkin`

```json
{ "ok": true, "today": "2026-11-10", "last": { "date": "2026-11-10", "status": "already", "message": "今天已签到，请明天再来", "at": 1794292142807 }, "status": null, "canClaim": true, "checkinEnabled": true }
```

`last` 是本地记录，`status` 是上游状态（上游没有状态接口时为 `null`，WorkBuddy 就是）。
`POST` 返回 `{ ok, result }`，`result` 是这次领取的记录（`status` 为 `checked` / `already` /
`disabled` / `error`）。

**`canClaim` 不看签到开关**：手动签到是允许的，开关只约束自动调度。

### `PATCH /api/accounts/:id/checkin-switch`

账号级签到开关。请求体 `{ "enabled": true | false }`：

```json
→ { "ok": true, "account": "qd-1", "checkinEnabled": false }
```

- 关掉后这个号不再**自动**签到；手动「一键签到」仍然会签——开关的意思是「别自动跑」，
  不是「不许签」。
- 被跳过的号会在 `checkin_log` 留一条 `status: "skipped"`，**每个账号每天只留一条**。
- 通道不支持签到（没有 `checkinClaimOf`）时回 400。

`GET /api/accounts` 的每个账号带 `checkinEnabled`。

### `GET /api/keys` / `POST /api/keys` / `PATCH /api/keys/:id` / `DELETE /api/keys/:id`

```json
GET  → { "keys": [{ "id": "k_26b8c82b", "label": "DSH 笔记本", "secret": "sk-<48 位字母数字>…", "prefix": "sk-<前 11 位>", "createdAt": 1794308660924, "lastUsedAt": 1794308668568, "enabled": true, "accountScope": null }] }
POST → 201 { "key": { "id": "k_d12ba056", "label": "样例", "prefix": "sk-<前 11 位>", … }, "secret": "sk-<48 位字母数字>" }
PATCH → { "ok": true, "key": { … } }
DELETE → { "ok": true, "removed": "k_d12ba056" }
```

- `secret` **存的是明文**（`api_key` 表；`data/` 已 gitignore 且在 Windows 上收紧 ACL），所以 `GET /api/keys` 和 `/keys` 页随时能「查看原文」——忘了复制不用删了重建。老记录（2026-11-11 之前建的）只有 scrypt 哈希，`secret` 为 `null`。
  格式和 OpenAI 的 key 同形：`sk-` + 48 位字母数字（共 51 字符）。`prefix` 是它的前 12 个字符，用来在列表上分辨。
- `PATCH` 接受 `{ "label"?, "enabled"? }`；停用**立刻**生效（下一次请求就 401）。
- `accountScope` 字段留着不实现（预留「这把 key 只能调 wb-1」）。

### `POST /api/models/settings`

**模型设置的唯一写入口**：上下文窗口、最大输出、缺省思考档。

这里的「唯一」是字面意思——设置只存在网关 `data/config.json` 的 `modelSettings` 里，
键是 `<idPrefix>/<上游模型 id>`（不含账号：上下文窗口是模型的属性，两个号挂同一个
模型该是同一个值）。早先网关和插件各存一份、各写一处，`min(两个值)` 就是为擦那个
屁股加的；现在那一套整个删了。

```json
POST { "prefix": "wb", "modelId": "deepseek-v4.1-flash",
       "contextWindow": 600000, "maxOutputTokens": 128000, "reasoningEffort": "high" }
→ { "ok": true, "setting": { "contextWindow": 600000, "reasoningEffort": "high" } }
```

- 字段都可选；传 `null` / `""` = **恢复默认**（删掉那个键，文件里不留 `"x": null`）。
- `contextWindow` 合法区间 8000..2000000，`maxOutputTokens` 256..2000000。
- `reasoningEffort` 必须是该模型档位表里的一档，否则 400（列出可选档位）。取不到
  上游目录时放行并记日志——网络问题不该让人连改都改不了。
- 生效值由 `applyModelSettings()` 在 `/v1/models`、`/api/models` 构建时套上去，
  所以**页面看到的就是实际报给客户端的**，不存在两份数。

**缺省思考档**：没配过时 = 该模型档位表里**最高**那一档（「默认打开思考」）。
它不写进 DSH profile（profile 里没有 per-model 默认档这个字段），而是在
`POST /v1/chat/completions` 里**客户端没发 `reasoning_effort` 时补上**。客户端显式
发了（包括 `"off"`）就一律尊重——DSH 的思考强度选择器是它的原生 UI，网关硬盖会让
那个控件变成摆设。

### `GET /api/models/catalog`（设置相关字段）

`/models` 页一行里要同时给出「上游上限 + 可选档位 + 当前生效值」，所以每个模型除了
原有的 `id` / `name` / `context_length` / `max_output_tokens` / `input`，还带：

```json
{
  "id": "deepseek-v4.1-flash",
  "input": ["text", "image"],
  "context_length": 1000000,
  "effectiveContextWindow": 1000000,
  "efforts": ["off", "low", "medium", "high", "xhigh"],
  "effectiveEffort": "xhigh",
  "setting": { "contextWindow": 600000, "maxOutputTokens": null, "reasoningEffort": null },
  "lengths": { "default": 300000, "options": [300000, 600000, 1000000] }
}
```

- `effectiveContextWindow`：缺省上下文窗口 = **这个模型允许的最大尺寸**（档位表的最大值，
  没有档位表就是上游报的 `context_length`）。**不是 `lengths.default`**——那是上游
  客户端选择器的默认档，可能小于它自己支持的上限；DSH 拿 `contextWindow` 规划压缩，
  取小值会提前压缩、白丢上下文。
- `contextLengthEstimated`：`true` 表示 `context_length` 是**网关的默认值**，不是上游
  报的（上游没给这个模型的窗口大小，通道落了 `config.defaultContextWindow`）。
  界面据此写「默认 20 万（上游未报）」而不是「最大 20 万」——「不知道」和「上游只有
  这么大」对使用者的行动建议完全不同。Qoder 的 `Auto` / `Fast` 就是这种。

- `efforts`：**网关算的**档位表。上游没报就用 `FALLBACK_EFFORTS`
  （`off/low/medium/high/xhigh`），上游的 `none` 在这里统一归成 `off`。
- `effectiveEffort`：当前缺省档（配过的优先，没配是最高的那档）。
- `setting`：用户配过的值，`null` = 跟随上游。
- `lengths`：可选上下文档位。上游客户端自己那个选择器的尺寸（WorkBuddy / Trae），
  Qoder 来自上游 `context_config`（200K/400K/1M），都没有就按上限推 50%/75%/100%
  ——**上下文窗口一律是下拉，不做自由填数字**。

### `GET /api/plugin-probe` / `POST /api/shutdown`

```json
{ "ok": true, "stage": "mount" }
{ "ok": true, "stopping": true }
```

`plugin-probe` 只往 `data/logs/plugin-probe.log` 追加一行（插件生命周期打点）。
`shutdown` 关掉进程——容器里用 `docker compose restart` 更省事。

### `GET /api/events`（SSE 事件流）

`Content-Type: text/event-stream`，长连接，**单向推送**（网关 → 插件）。要 Bearer key。

连上先收到一帧注释当握手（SSE 客户端据此确认流真的通了）：

```
: connected 2026-11-10T15:09:53.483Z
```

之后每 30 秒一行 `: keepalive`。真正的业务事件：

```
event: login
data: {"type":"login","channelId":"trae","taskId":"1794323394502-2","state":"running","loopback":{"port":18801,"path":"/authorize"},"message":null}
```

| 字段 | 说明 |
|---|---|
| `type` | 目前只有 `login` |
| `state` | `running` / `done` / `error` / `cancelled` |
| `loopback` | 需要「浏览器所在机器」把 `127.0.0.1:<port>` 转进来的信息；`null` 表示这个通道不需要（回调地址浏览器能直达） |

**为什么要有这条流**：Trae 的授权页只肯把浏览器跳回**环回**地址，而网关在容器里、浏览器
在用户笔记本上。插件收到 `state: running` 就在本机开 TCP 转发，收到其它状态就关掉。
用 SSE 而不是轮询，是因为「点登录」到「浏览器跳回」可能只有两三秒，轮询会错过。

断线即丢事件（没有重放）：订阅者没连着的时候，用户本来也开不了登录通道。


### `POST /api/models/visibility`

保存模型可见性。**只认 JSON**（旧版的 urlencoded 表单分支随 SSR 页面一起删了）。

| 字段 | 说明 |
|---|---|
| `prefix` | 通道短前缀（`wb`） |
| `action` | `toggle-list`（切总闸）/ `all`（恢复全部显示，连总闸一起打开）。都不给时按 `visible` 存勾选 |
| `listed` | `action: 'toggle-list'` 时用，布尔 |
| `visible` | 数组，要显示的模型 id。**空数组 ≠ 没配置**：空数组是「一个都不显示」，`action: 'all'` 才是「全部显示」 |

```json
{ "ok": true, "prefix": "wb", "visible": ["hy4free"] }
```

改一次对该通道**所有账号**生效（键是 `idPrefix`，不是账号 id）。

---

## 三、哪些东西不在 API 里

- **HTML 页面**：服务端不出页面，界面是 `web/` 里的 SPA。登录页、账号页都不是端点。
- **表单动作**：2026-11-13 全部删除。旧版的 `POST /accounts/:id/toggle`、`POST /keys`、
  `POST /settings/checkin` 之类现在一律 404——它们的 JSON 等价物都在 §二里。
- **没有「用密码换 token」的端点**：API 凭据是 `POST /api/keys` 发的（界面在 `/keys`），
  不是登录换来的。浏览器的会话 Cookie 和 API key 是两套独立凭据，互相不能替代。
- **模型目录（全量）**：`/api/models` 和 `/v1/models` 都**过了可见性**。要看全量（包括被
  隐藏的）用 `/api/models/catalog?account=<id>`，它直接调 `channel.modelsOf(account)`。
- **上游原始目录**：`/api/models/catalog` 的 `lengths` 字段带了一部分（`catalogOf()` 提供的
  可选尺寸），只对「有 `catalogOf()` 的通道」生效（WorkBuddy / Trae）。`/api/models/settings`
  不再暴露它——设置只按 `<prefix>/<上游模型 id>` 存，账号不参与。