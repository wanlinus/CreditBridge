# CreditBridge

> 把五个 AI 平台的积分，转成**标准 OpenAI 接口**，并**挂在服务器上自动签到攒积分**，
> 给 DSH 或任何 OpenAI 兼容客户端用。

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

CreditBridge 是一个本机部署的 OpenAI 兼容网关。它把 WorkBuddy / Trae CN / Qoder / Loomy / 豆包
五家的**私有接口**统一成 `/v1/chat/completions`，并让你用「指定账号」的额度付账。

```
你的客户端 ──OpenAI 协议──▶ cb-gateway ──各平台私有协议──▶ 上游
                              （花指定账号的积分）
```

> ⚠️ 五个通道走的都是客户端**私有接口**，不是官方开放 API。是否违反各自服务条款请自行判断，
> 账号被限、额度被清的风险自担。详见[风险声明](#风险声明)。

## 目录

- [背景](#背景)
- [安装](#安装)
- [使用](#使用)
- [五个通道](#五个通道)
- [仓库结构](#仓库结构)
- [开发](#开发)
- [已知限制](#已知限制)
- [常见问题](#常见问题)
- [许可证](#许可证)
- [风险声明](#风险声明)

## 背景

四个主流 AI 客户端（WorkBuddy、Trae CN、Qoder、Loomy）加上豆包，各自给用户发「积分」或「额度」，
但接口互不相通、没有统一的 OpenAI 出口，而且**每日积分要登录客户端手动领**。CreditBridge 解决三件事：

1. **统一协议**：五家私有接口 → 一个 `/v1/chat/completions`
2. **统一账号**：一个平台挂多个号，用哪个号由模型 id 指定（`wb-1/deepseek-v4.1-flash` 里的 `wb-1`）
3. **自动签到**：网关跑在服务器上，每天定时替所有账号签到领积分，失败自动重试，不用每天开客户端

所以它适合跑在一台 24 小时开着的机器（NAS、云主机、家里的旧电脑）上：对话走 OpenAI 协议，
积分靠自动签到细水长流地攒。网关本身无状态、无子进程，跑在 Docker 里，用浏览器网页管理。

## 安装

### 前置条件

- **Docker**（网关以镜像方式分发，本机不用装 Node）
- 五个平台各自的账号（有一个就能用）

### 拉镜像起容器

镜像在 GitHub Container Registry，公开可拉：

```bash
docker pull ghcr.io/wanlinus/creditbridge:latest

docker run -d \
  --name cb-gateway \
  --restart unless-stopped \
  -p 7801:7801 \
  -v cb-data:/app/data \
  ghcr.io/wanlinus/creditbridge:latest
```

浏览器打开 <http://127.0.0.1:7801/login> 能出登录页就装好了。

**数据在 `cb-data` 卷里**（凭据、账号、账本、日志）。用命名卷而不是目录挂载，是因为容器以
uid 1000 运行，宿主机目录的权限经常对不上——命名卷没这个问题。

想用本地目录（方便直接看文件）：

```bash
mkdir -p ./cb-data
sudo chown 1000:1000 ./cb-data        # 容器里是 uid 1000
docker run -d --name cb-gateway -p 7801:7801 -v "$PWD/cb-data:/app/data" ghcr.io/wanlinus/creditbridge:latest
```

### 首次配置

1. **改默认密码**：浏览器 `/login` 用 `admin` / `admin` 登录，会被强制跳到 `/password` 改密
   （≥6 位、不能和旧密码相同）。改密之前，除 `/login` `/password` `/logout` 外所有接口都拒绝。
2. **建一个 API key**：进 `/keys` 页新建。整串 `sk-...` 只显示一次，网关只存 scrypt 哈希。
   格式和 OpenAI 的 key 同形（`sk-` + 48 位），OpenAI 客户端配置里能直接粘。
3. **加账号**：进 `/accounts` 页 → 选通道 → 「开始登录」→ 按提示在浏览器完成授权。
   每个号登一次就多一套模型 id。

## 使用

网关对外是标准 OpenAI 协议，任何客户端都能连：

```bash
curl http://127.0.0.1:7801/v1/models \
  -H "Authorization: Bearer sk-你的key"
```

```bash
curl http://127.0.0.1:7801/v1/chat/completions \
  -H "Authorization: Bearer sk-你的key" \
  -H "Content-Type: application/json" \
  -d '{"model":"wb-1/deepseek-v4.1-flash","messages":[{"role":"user","content":"你好"}]}'
```

### 模型 id 格式

模型 id 是 `<账号id>/<模型名>`，比如 `wb-1/deepseek-v4.1-flash`：

| 部分 | 含义 |
|---|---|
| `wb` | 通道前缀（`wb` WorkBuddy / `tr` Trae / `qd` Qoder / `lo` Loomy / `db` 豆包） |
| `-1` | 这个通道的第 1 个号 |
| `/deepseek-v4.1-flash` | 上游的模型名 |

「用 2 号号的 hy4free」就是 `wb-2/hy4free`。**网关不会自动换号**——写哪个号就花哪个号的额度。

### 管理操作

所有管理操作都在**网关网页**上：

| 页面 | 干什么 |
|---|---|
| `/accounts` | 加号、重新登录、停用、看余额、开关自动签到 |
| `/models` | 哪些模型出现在 `/v1/models`、上下文窗口、思考强度 |
| `/checkin` | 签到日志、一键签到 |
| `/keys` | API key 管理 |
| `/settings` | 改密码、改每日签到时间 |

### 签到

四个通道有每日签到（Loomy 上游没有这个接口）。**账号登录一次之后就不用再管**：
网关跑在服务器上，默认每天 **10:05** 自动替所有账号签一次，失败按 10/30/60 分钟阶梯重试。

- 在 `/accounts` 每行的「更多」里可以关掉某个号的自动签到
- 手动点「一键签到」不受开关限制（开关是「别自动跑」，不是「不许签」）
- 某个号被跳过时，`/checkin` 日志里有一条「已跳过」——不会静默
- 签到时间在 `/settings` 页改

### 余额和用量

`/api/usage` 和概览页有 token 统计和「折合 DeepSeek 费用」。注意：

- **token 是上游报的数**，网关不自己数（各家 tokenizer 不同，自己数对不上账单）
- **积分只读官方余额**，不做逐请求结算
- **折合费用是参照系，不是账单**——这些 token 花在五家上游，不走 DeepSeek 的 API

### DSH 插件（可选）

用 DSH 的话，装 `cb-dsh/` 插件后有两个便利：

1. 侧边栏填一次「网关地址 + key」，插件自动写进 DSH 配置（不用手改 YAML）
2. 输入框右侧显示当前账号的余额

不用 DSH 就跳过——网关本身是完整的 OpenAI 服务。插件装法见 [cb-dsh/README.md](cb-dsh/README.md)。

## 五个通道

| 通道 | idPrefix | 上游 | 模型来源 |
|---|---|---|---|
| **WorkBuddy** `workbuddy` | `wb` | `copilot.tencent.com` | 上游 `/v3/config` 实时目录 |
| **Trae CN** `trae` | `tr` | `trae-api-cn.mchost.guru` | 服务端配置 `batch_get_detail_param` |
| **Qoder** `qoder` | `qd` | `openapi.qoder.com.cn` | 上游 `/algo/api/v2/model/list` |
| **Loomy** `loomy` | `lo` | `loomyad.xunfei.cn` | 上游 `/api/v1/models` |
| **豆包** `doubao` | `db` | `www.doubao.com` | 上游 `/alice/slot/action_bar_v3/brief_list` |

五个都是纯 HTTP，没有子进程。

**豆包有两点特殊**：

- **不报 token 用量**（对话 SSE 里没有任何计数字段），所以豆包账号在概览页只有余额、没有用量数字
- **对话有独立风控**，高频请求会要求真人验证（登录时也可能会要求二次验证：发短信 / 扫码 / 推送确认）

## 仓库结构

```
CreditBridge/
├─ .github/workflows/ci.yml     CI：类型检查 + 测试 + 构建镜像推 GHCR
├─ cb-gateway/                  网关（TypeScript，无构建步骤）
│  ├─ src/
│  │  ├─ index.ts app.ts          启动 / Hono 实例
│  │  ├─ routes/                  openai · admin · accounts · keys · json-actions
│  │  ├─ core/                    accounts · router · credits · keys · checkin-scheduler
│  │  ├─ channels/                types.ts 契约 + 5 个通道
│  │  ├─ auth/                    认证闸 + 强制改密闸
│  │  └─ shared/                  paths · sse · 定价 · 可见性 · 网关凭据
│  ├─ web/                       前端 SPA（Vue 3 + Vite）
│  ├─ scripts/deploy.ps1         拉 GHCR 镜像 → 重建容器
│  ├─ test/                      19 套，`npm test` 全跑
│  └─ data/                      凭据、账号、签到、用量、日志（明文 token，勿提交）
├─ cb-dsh/                       DSH 插件（host 半边 + client 半边）
├─ docs/                         添加通道指南等
├─ packaging/                    打包脚本
├─ tools/                        开发诊断脚本
└─ private/                      **不发布**（.gitignore）
   ├─ docs/                      逆向记录、重构方案
   ├─ tools/                     逆向探针脚本（mitm 等）
   └─ probes/                    解包出来的大文件
```

更细的说明：

- [网关 README](cb-gateway/README.md) — 起服务、认证、路由清单、排错
- [网关架构](cb-gateway/ARCHITECTURE.md) — 组件、数据流、`Channel` 契约、不变量
- [网关 API](cb-gateway/API.md) — 每条路径的请求/响应形状
- [插件 README](cb-dsh/README.md) — 配置向导、登录回调转发、模型同步
- [添加一个通道](docs/adding-a-channel.md) — 想接入新上游时看这个
- [AGENTS.md](AGENTS.md) — 改代码前的约定（架构原则、平台坑、提交规范）

> `private/` 不在公开仓库里。源码注释里 `private/docs/xxx.md` 的引用指向作者本地的笔记，
> clone 下来点不开是正常的。

## 开发

**只有改代码才需要看这节**。日常使用直接拉镜像，不用装 Node。

```bash
cd cb-gateway

# 装依赖（网关用 npm，前端用 pnpm）
npm ci
cd web && pnpm install && cd ..

# 构建前端 —— 必须先跑，否则 e2e-http 那套会失败
pnpm --dir web build:only

# 检查 + 测试
npm run check        # tsc --noEmit，必须 0 error
npm run check:web    # vue-tsc
npm test             # 19 套，一条命令全跑
```

> **`npm test` 依赖 `web/dist`**：`test/e2e-http.mjs` 要验证静态资源能被托管。
> 没构建前端时它会有 1 项失败，看起来像代码坏了，其实只是缺产物。

加通道改两处：新建 `src/channels/<name>/`，再在 `src/channels/index.ts` 加一行。
不需要动 `app.ts` / `routes/*` / 前端。

### CI

推送到 `master` 或提 PR 时，GitHub Actions 自动跑（[`.github/workflows/ci.yml`](.github/workflows/ci.yml)）：

| job | 干什么 |
|---|---|
| `check` | 装依赖 → 类型检查（网关 + 前端）→ 构建前端 → `npm test` |
| `image` | 构建 Docker 镜像推到 GHCR，依赖 `check` 通过 |

标签规则：`master` → `latest` + `edge`；打 `v1.2.3` 这样的 tag → `1.2.3` + `1.2` + `latest`。
PR 只构建不推送。

## 已知限制

- **私有接口，随时可能变**。上游改版、加风控不会提前通知。
- **TLS 指纹对不上**：网关是 Node 的 TLS 栈，客户端是 Chromium 的 BoringSSL。目前上游没查。
- **模型数量随账号数线性增长**：2 个号 = 2 套 id。嫌多就去 `/models` 按通道关掉或勾选。
- **Trae 登录需要环回回调**：回调必须是 `http://127.0.0.1:18801/authorize`。
  从容器外登录那次要开隧道：`ssh -N -L 18801:127.0.0.1:18801 <用户>@<网关地址>`。
  入口页必须是 `/login?...` 而不是 `/authorization?...`。
- **Trae 的单次消耗是算出来的**：它不回报单次积分，网关在请求结束后读计数器做差，
  账本那一行会晚几秒落盘，偶尔缺 `credit`。
- **上下文窗口和思考强度只在网关设**：DSH 的模型 schema 只有单值 `contextWindow`。
  在 `/models` 页改，插件负责把 `/api/models` 照抄进 profile。
- **Qoder 的缓存命中率是推算的**：它不报 `cached_tokens`。费用折算按其他通道的实测率推算，
  面板上会标出「其中多少是推算的」。

## 常见问题

| 症状 | 原因 / 怎么办 |
|---|---|
| `403 还没改过默认密码` | 浏览器 `/login` 登 `admin/admin` → `/password` 改密 |
| `401` 未登录 | key 对不对；`/keys` 页看有没有这把 key |
| `404 没有账号 wb-9` | 模型 id 里的账号不存在。去 `/accounts` 看现有账号 |
| `404 不认识模型 id "workbuddy/hy4free"` | 这是 v1 的旧格式。现在是 `wb-1/hy4free` |
| 模型列表为空 | `/accounts` 里一个号都没有，或者号的状态不是 `ready` |
| `429 账号 wb-1 限流中` | 上游按模型限流，状态机自动冷却、到点恢复。急用就换一个号的模型 |
| `503 账号 wb-1 的凭据已失效` | 上游回 401。去 `/accounts` 点「重新登录」 |
| 容器一直 unhealthy | `host` 不是 `0.0.0.0`，或 `data/` 卷权限不对（容器以 uid 1000 写） |
| 改了源码没生效 | 镜像没更新。等 CI 构建完，然后 `docker compose pull && docker compose up -d` |

DSH 插件相关的问题见 [cb-dsh/README.md](cb-dsh/README.md)。

## 许可证

[MIT](LICENSE) © 2026 wanlinus

## 风险声明

`copilot.tencent.com`、`trae-api-cn.mchost.guru`、`openapi.qoder.com.cn`、`loomyad.xunfei.cn`、
`www.doubao.com` 都是对应客户端的**私有接口**，不是官方开放 API。

- 是否违反各自服务条款，请自行判断
- 账号被限制、额度被清空的风险自担
- 请求指纹改写只是为了通过它们的正常校验，不是为了伪造身份

本项目仅供个人学习研究，作者不对使用后果负责。
