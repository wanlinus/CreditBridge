# 添加一个通道

这份指南写给想接入新上游的人。按它做完，新通道的模型会自动出现在 `/v1/models` 里，
账号能在网页上登录、余额能显示、对话能走、账本能记——**不用改路由、不用改前端、不用改插件**。

先读一遍[架构原则](../AGENTS.md#架构原则通道自述界面只认清单)：这个项目的核心约束是
**通道自述、界面只认清单**。你写的通道不需要被任何地方「认识」。

---

## 零、先确认你能拿到什么

写通道的本质是**照着上游客户端的协议做翻译**。动手前先确认三件事：

| 要确认的 | 为什么 |
|---|---|
| 上游的对话接口长什么样 | 决定 `chatAs` 怎么写。是 OpenAI 兼容？还是私有 SSE？ |
| 凭据怎么拿、怎么续 | 决定 `login` 和 `auth.ts`。有 refresh token 就简单，只有 session 就麻烦 |
| 有没有余额/签到接口 | 有就实现 `creditsOf` / `checkinClaimOf`，没有就让 `creditsOf` 抛错（界面会显示「不支持」） |

**拿不到协议就写不了。** 这个仓库的开发方式是「先逆向客户端、抓包、还原协议，再写适配器」。
如果你只是想接一个已经有公开 OpenAI 兼容接口的服务，那不需要写通道——
在网关外面套一层就行，或者在 `modelsOf` 里写死模型清单。

---

## 一、要动的文件

**只有一个目录 + 一个文件的一行。**

```
cb-gateway/src/channels/<name>/
├─ index.ts       通道对象（只做声明和转发，60~80 行）
├─ auth.ts        凭据刷新 + 请求头
├─ models.ts      模型目录
├─ upstream.ts    对话翻译
├─ usage.ts       余额 / 签到
├─ login.ts       交互式登录（可选）
└─ icon.png       品牌图标（可选，64×64 PNG 四角透明）
```

```
cb-gateway/src/channels/index.ts    加一行 import + 一个数组项
```

**不要改** `app.ts` / `routes/*` / `web/src/*` / `cb-dsh/lib/*`。
如果你发现必须改它们，说明有硬编码漏在编排层——先把它拆掉，再继续加通道。

### `index.ts` 长什么样

照 `loomy/index.ts` 抄，它是最短的（65 行）。**下面这段是通过 `tsc --noEmit` 验证过的**
（除了示例里没用 `account` 参数会报「未使用」，真实通道会用到）：

```ts
import type { AppConfig } from '../../types.ts';
import { defineChannel } from '../types.ts';

let config!: AppConfig;
const setLogger = (_fn: (...args: unknown[]) => void) => {};

export const myChannel = defineChannel({
  id: 'mychannel',          // 账本 provider、账号 channelId 都用它
  idPrefix: 'mc',           // 模型 id 前半段：mc-1/model-name
  label: 'My Channel',      // 界面显示名

  identity: {
    clientVersion: '1.2.3', // 报给上游的客户端版本，见「坑」第 1 条
  },

  configure({ log, config: next }) {
    config = next;
    setLogger(log);         // 不接这根线，你的日志不进 data/logs/
  },

  async modelsOf(account) {
    const base = String(account.id).split('-')[1] ?? '1';
    return [
      {
        id: `mc-${base}/example-model`,   // 注意：id 前半段要和 account.id 一致
        object: 'model',
        name: 'Example',
        context_length: config.defaultContextWindow,
        max_output_tokens: config.defaultMaxTokens,
        contextLengthEstimated: true,     // 上游没报窗口时标上，界面会显示「估算」
      },
    ];
  },

  async creditsOf(account) {
    return {
      provider: 'mychannel',
      supported: true,
      totalRemain: 0,
      account: { uid: account.profile?.uid },
    };
  },

  async chatAs(account, request) {
    const res = await fetch('https://example.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request.body),
      signal: request.signal,           // 必须传，见「三条最容易写错的」第 2 条
    });
    return { kind: 'json', status: res.status, body: await res.json() };
  },

  async login(options) {
    options?.onUrl?.('https://example.com/auth');
    return { credential: { token: 'x' }, profile: { uid: 'u1', username: 'demo' } };
  },
});
```

**`modelsOf` 返回的 `id` 前缀必须和 `account.id` 一致**：账号 `mc-1` 的模型必须是
`mc-1/xxx`。写成 `mc-2/xxx` 会让路由找不到账号，请求 404。

然后 `channels/index.ts`：

```ts
import { myChannel } from './mychannel/index.ts';

export const channels: Channel[] = [workbuddyChannel, traeChannel, qoderChannel, loomyChannel, myChannel];
```

就这么多。

---

## 二、`Channel` 契约

完整定义在 [`src/types.ts`](../cb-gateway/src/types.ts) 的 `Channel` 接口。这里只讲**必须实现什么**。

### 必需成员（漏一个启动就抛错）

`defineChannel()` 校验这 7 个：

| 成员 | 类型 | 要点 |
|---|---|---|
| `id` | `string` | 非空、唯一。账本的 `provider`、账号的 `channelId` 都是它 |
| `idPrefix` | `string` | **只能小写字母和数字**（`defineChannel` 校验）。它是模型 id 的前半段，带 `-` 会切不开、带 `/` 会被当分隔符 |
| `label` | `string` | 界面显示名 |
| `identity` | `ChannelIdentity` | `clientVersion` 必填非空 |
| `modelsOf(account)` | `Promise<ModelInfo[]>` | **按账号取**，不要缓存成通道级 |
| `creditsOf(account)` | `Promise<Credits>` | 失败**直接抛错**，路由会包成 `{supported:false, error}` 仍回 200 |
| `chatAs(account, request)` | `Promise<ChatOutcome>` | 失败抛 `UpstreamError` |

`ModelInfo` 最少要这几个字段（完整定义见 `src/types.ts`）：

```ts
{
  id: 'mc-1/model-name',      // 前缀必须和 account.id 一致
  object: 'model',
  name: '显示名',
  context_length: 200_000,
  max_output_tokens: 8_000,
  contextLengthEstimated: true,   // 上游没报窗口时标上
}
```

`Credits` 最少要这几个：

```ts
{
  provider: 'mychannel',
  supported: true,          // 通道没有余额接口时给 false
  totalRemain: 1234,        // 徽标唯一读的数字
  account: { uid: '...' },  // 可选
}
```

### 可选成员（实现了界面自动多出按钮）

| 成员 | 什么时候实现 |
|---|---|
| `configure(ctx)` | 几乎总要——把 `log` 接进自己的模块 |
| `login(options)` | 支持自助登录。返回 `{credential, profile, label}`，**不写盘** |
| `loginLoopback()` | 回调必须从浏览器那台机器的环回地址打进来时 |
| `probe(account)` | 能验证凭据还有效（管理台「检测」按钮） |
| `catalogOf(account)` | 有上游原始目录（带档位表），给上下文窗口编辑器用 |
| `checkinStatusOf` / `checkinClaimOf` / `lastCheckinOf` | 支持签到 |
| `rotateDeviceIdOf(account)` | 上游按**设备**记状态、多号不该共用设备号时 |
| `logoutOf(account)` | 上游有注销接口 |
| `multiAccount` | 默认 `true`。`false` 表示只能挂一个号 |
| `reportsTokens` | 默认 `true`。`false` 时账本 token 恒 0，界面显示 `—` |

### `ChatOutcome`

```ts
type ChatOutcome =
  | { kind: 'json';   status: number; body: unknown }
  | { kind: 'stream'; status: number; headers: Record<string, string>; body: AsyncIterable<string> };
```

- 回哪种由**你**决定（看上游的 content-type）。路由层只按形态发响应。
- `body` 是**文本块**的异步迭代器：SSE 就逐帧 `yield`，路由层负责编码成字节。
- **拿到用量就调 `request.onUsage(usage)`**（流式在最后一个 chunk 之后）。不要自己记账——
  `provider` / `account` 两段身份由路由层补。
- 失败抛 `UpstreamError(status, message, { code, retryAt })`：
  - `401` → 路由把账号标 `invalid`
  - `429` → **不改账号状态**，原样回给客户端（限流按模型、恢复时间网关猜不准）
  - 其余不动

---

## 三、三条最容易写错的

### 1. 凭据要「新鲜」

不要直接用 `account.credential`，用 `usableCredential()`：

```ts
import { usableCredential } from '../../core/accounts.ts';

const credential = await usableCredential(account, refreshFn);
// 401 重试时：
const credential = await usableCredential(account, refreshFn, { forceRefresh: true });
```

它处理过期判断和**并发单飞**（多个请求同时发现过期，只刷一次），结果写回账号。

**401 重试必须传 `forceRefresh: true`**：本地算出的有效期还没到时，不强制刷会拿回同一枚
被拒的令牌，然后永远 401。

### 2. 客户端断开要传下去

```ts
const signal = AbortSignal.any([request.signal, AbortSignal.timeout(120_000)].filter(Boolean));
const res = await fetch(url, { method: 'POST', body, signal });
```

不传的后果：用户关掉对话后，网关还在往一个没人收的流里读，**白烧上游额度且不报任何错**。

### 3. 请求体只能读一次

`request.body` 是已经解析好的对象。401 重试时**直接重新发它**，不要回头再读流。

---

## 四、凭据与登录

### 凭据就是 `account.credential`

一个 `any` 对象，形状由你定，存在 `gateway.db` 的 `account` 表（JSON 文本）。
**通道不知道「自己挂了几个号」**——凭据由 `Account` 对象传进来，循环账号、判状态、记账全在路由层。

### `login()` 不写盘

```ts
async login({ onUrl, onPrompt, signal }) {
  // 1. 拿授权 URL → onUrl(url) 交给调用方打开浏览器
  // 2. 等回调（自己起一个 HTTP server）
  // 3. 换 token
  return { credential, profile: { uid, username }, label: '显示名' };
}
```

**不要自己打开浏览器**：网关常常部署在没有浏览器的机器上（容器）。只把地址交出去。

存成第几号账号是账号层的事，你只管返回凭据。

### 两种登录交互

| 形态 | 用哪个回调 | 例子 |
|---|---|---|
| URL 授权（浏览器里点同意） | `onUrl(url)` | WorkBuddy / Trae / Qoder |
| 向用户要输入（手机号、验证码） | `onPrompt(prompt)` | Loomy |

`onPrompt` 会被调多次（手机号 → 验证码），每次返回的 promise 在用户提交后 resolve、
取消登录时 reject（由登录任务层在 `signal` abort 时触发）。

`signal` 触发时要**立刻**关掉自己的回调服务器，否则旧任务占着端口空转到超时。

---

## 五、验证

### 静态检查

```bash
cd cb-gateway
npm run check     # tsc --noEmit，必须 0 error
npm test          # 21 套全跑
```

### 硬编码自查（必做）

```powershell
grep -n '"mychannel"' cb-gateway/src cb-dsh/lib
```

命中**只应**出现在 `channels/mychannel/` 和 `channels/index.ts`。
插件侧一处都不该有——图标和文案都由网关按通道 id 自己查。

### 真机验证

起网关（`node src/index.ts` 或镜像），然后：

```bash
A="Authorization: Bearer sk-你的key"
B="http://127.0.0.1:7801"

# 1. 通道出现在 /api/health，带 idPrefix / identity / listed / multiAccount
curl -H "$A" "$B/api/health"

# 2. 外观：图标是 data URI（缺图时退回 letter）
curl -H "$A" "$B/api/channels"

# 3. 加好账号后，模型列表里能看到 mc-1/<model>
curl -H "$A" "$B/v1/models"

# 4. 余额
curl -H "$A" "$B/api/accounts/mc-1/credits"

# 5. 对话（SSE）
curl -N -H "$A" -H "Content-Type: application/json" \
  --data-binary '{"model":"mc-1/xxx","messages":[{"role":"user","content":"你好"}],"stream":true}' \
  "$B/v1/chat/completions"

# 6. 账本里有那一行，provider 和 account 都对
curl -H "$A" "$B/api/accounts/mc-1/usage"
```

六条都过才算接完。

---

## 六、踩过的坑

这些都是真实踩过的，按顺序看能省几个小时。

**1. 版本号写死会烂。** 上游拿 `clientVersion` 当「客户端够不够新」的门禁。Trae 的版本串
停在 `3.4.15` 时，换令牌回的是 `401 20405 Device proof required`——看起来像签名问题，
实际是版本太旧。客户端升级后要跟着改，所以它是**必填且非空**的。

**2. 「取不到目录」不等于「没有模型」。** 未登录、上游拒绝都会让 `modelsOf` 抛错。
路由会跳过那个**账号**并记日志，`/v1/models` 仍是 200。**别让通道回 5xx**——
那会让整个模型列表失败。

**3. 别在通道里写 `data/`。** 凭据、签到记录按账号存在 `gateway.db` 里，路径由
`shared/paths.ts` 给。写成通道级单份的话多账号会互相覆盖。

**4. 设备密钥对要跟着凭据走。** 如果上游要签名，那把私钥必须和登录时注册的是同一把。
放共用文件里的话，第二个号登录会把第一个号的覆盖掉，它过期后再也刷不回来。

**5. 字段映射错了不会报错。** 上游报 `cache_read_input_tokens`，如果没映射成
`prompt_tokens_details.cached_tokens`，界面上「缓存命中」恒为 0——数字看着正常，其实是错的。
**拿到上游的 usage 帧，逐个字段核对一遍。**

**6. 只读 HTTP 状态码会误判成功。** 有的上游是「外层 200 + 内层 403」：
HTTP 层成功、业务层失败。必须解包看内层错误码。

**7. `0` 是合法数字。** 余额接口返回 0 和「读取失败」是两回事。读取失败要抛错，
不要 `?? 0` 兜底——那会让界面显示「剩余 0」像是额度用光了。

**8. 签到「空数组」不等于「已签到」。** 上游回空 `campaigns` 可能是「今天没活动」，
也可能是「你缺了个请求头所以什么都没返回」。这两种必须能区分。

---

## 七、参考实现

四个现有通道按复杂度排：

| 通道 | 行数 | 适合看什么 |
|---|---|---|
| `loomy/` | 约 830 | **最简单的完整实现**：标准 OpenAI 兼容上游、短信登录 |
| `workbuddy/` | 约 1000 | 渠道短语改写、多账号目录缓存 |
| `qoder/` | 约 1860 | 私有 SSE 分帧、wasm 现算签名、多账号隔离 |
| `trae/` | 约 1880 | 请求体加密、设备号轮换、签到重试 |

**从 `loomy/` 开始抄**，它是唯一一个上游本身就是 OpenAI 兼容的通道，其余三个都要翻译协议。

---

## 八、提交前

- [ ] `npm run check` 0 error
- [ ] `npm test` 全绿
- [ ] 硬编码自查：`grep` 只命中 `channels/<name>/` 和 `channels/index.ts`
- [ ] 真机验证六条都过
- [ ] 没在通道里写 `data/`
- [ ] `identity.clientVersion` 是当前客户端版本
- [ ] 注释只写「为什么」和坑，不写设计原理（见 [AGENTS.md](../AGENTS.md#语言与注释)）
