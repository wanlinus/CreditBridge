# CreditBridge（分发包说明）

> ✅ **2026-11-11 起这套脚本已按 v2 的现状改过，能产出可用的包。**
>
> 之前它按 **v1 的形态**写：通道前缀路由（`/workbuddy/v1`、`/trae/v1`）、面板走
> Basic 认证填账号密码、装完要手动跑 sync 脚本生成 `models:`。v2 之后这些**全都不成立了**：
> 通道前缀路由已删、Basic 已删、模型同步改由插件的 host 半边自动做。
>
> 那次修正覆盖了：`extract-providers.mjs` 改为只产出**骨架**并剥离
> `baseURL` / `apiKeyEnv` / `models` / `headers`（不再把打包机的真实 token 拷进包）、
> `merge-providers.mjs` 改为保留收件人已填的本机字段、`build.ps1` 的校验改成按形态认、
> `install.ps1` 的探活从已删的 `/health` 改成公开的 `/login`。
> 逐条见文末「已知待修」（现已全部标记为已修）。
>
> 尚未重跑过 `build.ps1` 做端到端验证——脚本逻辑与产出形状已用真实 profile 实测，
> 但「真的打出 zip 再在干净机器上装一遍」还没做过。发给别人前建议先自己走一遍。

给**拿到 zip 的人**看的。`install.ps1` 走本机安装，和仓库里 `192.168.1.100` 上的容器部署不是一回事。

CreditBridge 把几个 AI 客户端账号里的额度，变成 DSH 里可直接选来对话的模型：`cb-gateway` 是本机 OpenAI 兼容网关（TypeScript 无构建步骤，`node src/index.ts` 直跑）；`cb-dsh` 是 DSH 插件，负责把网关地址和 API key 写进 DSH 配置，并在输入框右侧显示余额徽标。装完后在 DSH 模型选择器里选对应的模型即可对话，计费走那个账号的积分。

> 模型 id 的形状是 `wb-1/hy4free`：前半段是「通道短前缀-账号序号」，后半段是上游模型。
> 通道只作为模型 id 的前半段存在，**没有**按通道的前缀路由。

**私有接口风险（务必先读）**：网关走的是各客户端的私有接口（`copilot.tencent.com`、`trae-api-cn.mchost.guru`、`openapi.qoder.com.cn` 的 `/sash/*` 与 CLI 通道、`loomyad.xunfei.cn`），**不是官方开放 API**。是否违反服务条款请自行判断，账号被限流、被封或积分被清空的风险自担。包里不含任何人的账号信息或 token：`data\` 整个不进包，`providers.json` 也已剥离 `baseURL` / `apiKeyEnv` / `models` / `headers`。

## 安装

前置：**Windows**；**DSH 已安装并至少启动过一次**（安装脚本借用 DSH 自带的 Node + pnpm，找不到时要自己装 Node.js 22+ 和 pnpm，网关是 TS 直跑，Node 必须 ≥ 22.18）；各通道账号由你装完后在**网关网页** `/accounts` 自己登录获得（WorkBuddy / Trae / Loomy 走浏览器或表单授权；Qoder 需要 CLI 登录态，网关会自己下载 CLI 并引导授权）。

解压到任意目录，**路径不要有中文和空格**。zip 里是一个 `CreditBridgeForDSH` 文件夹，进去运行 `powershell -ExecutionPolicy Bypass -File .\install.ps1`；脚本按顺序做：

1. 检查 `~\.dsh` 与 `~\.dsh\profiles\desktop` 存在；定位 DSH 自带或系统的 Node + pnpm。
2. 把网关装到 `%LOCALAPPDATA%\CreditBridge\gateway`：已存在时**保留 `data\`**（凭据与账本），其余删掉重拷；`data\config.json` 不存在就写一份默认的（`127.0.0.1`、`7801`、默认上下文窗口与 `maxTokens` 等；单个模型的上下文窗口/思考档在 `/models` 页改）。
3. 装插件：备份 profile `package.json` → 写 `dependencies["cb-dsh"] = file:<本包 tgz 的绝对路径>` → 加进 `dsh.profile.bundles` → 删 `pnpm-lock.yaml` → `pnpm install` → 校验 `node_modules\cb-dsh\lib\client.js` 存在；`pnpm install` 失败会回滚 `package.json`。
4. 跑 `merge-providers.mjs` 把 `providers.json`（网关 provider 的**骨架**）并进 `cordis.patch.yml` 的 `llm-pi-ai` 条目：只动传入的那个键、幂等，**保留你已经填过的 `baseURL` / `apiKeyEnv` / `models`**，原文件备份成 `.bak-cb-gateway`。注意 **YAML 会重排、原有注释会丢**。
5. 起网关（`Start-Process` 后台跑 `src\index.ts`，工作目录 `%LOCALAPPDATA%\CreditBridge\gateway`），轮询公开的 `/login` 最多 20 秒（`/api/health` 要登录，不能拿来探活），然后提示重启 DSH。

可选参数：`-SkipPlugin`（只装网关，把任意 OpenAI 兼容客户端指向 `http://127.0.0.1:7801/v1`）、`-Uninstall`（见「卸载」）。

- `install.ps1` **不会**替你改网关密码、**不会**替你建 key、**不会**替你配 DSH。这些必须装完手动做（见下）。
- 本包 `providers.json` 只带**网关那一个** provider 的骨架（靠 `baseURL` 路径正好 `/v1` 认出来），**不含 `baseURL` / `apiKeyEnv` / `models` / `headers`**——那四项是收件人机器的事实，装完在「积分桥」面板填地址 + key 后由插件写入。v2 的 profile 里只有一个 provider，通道只体现在模型 id 的前半段。

## 装完必须手动做的三件事

网关**所有接口都要登录**（认证闸在所有路径之前）。首次启动会在 `%LOCALAPPDATA%\CreditBridge\gateway\data\auth\gateway.json` 生成默认账号 `admin/admin`；**改密之前除 `/login` `/password` `/logout` 外一律拒绝**（页面 302、API 401/403，错误 `password_change_required`）。

**1. 改网关密码** —— 浏览器打开 <http://127.0.0.1:7801/login>，用 `admin/admin` 登录会强制跳到 `/password` 设置新密码。

**2. 建一把 API key** —— 登录后去 `/keys` 新建，整串 `sk-…` 会显示出来。忘了复制也没关系：从 2026-11-11 起明文存在 `keys.json` 里，列表每行点「查看」还能看回来。

**3. 在积分桥面板里填地址和 key** —— 侧边栏「积分桥」→ 网关地址 + API key → 保存。host 半边会存配置、写好 profile 的 provider、拉 `/api/models` 写 `models:` 段，**重启 DSH 后模型选择器里就有了**。

> **加账号不在面板里做**，在**网关网页** `/accounts`：选通道 → 开始登录 → 浏览器里完成。每个号登一次，就多一套模型 id。
>
> 旧的 v1 做法（面板填用户名密码走 Basic、手动往 provider 里塞 `headers.Authorization`、手跑 sync 脚本）**都已经不成立**：Basic 认证在网关侧删了，`apiKey` / `headers.Authorization` 也不是 DSH 现在认的字段。

## 模型列表：由插件自动同步

**DSH 不从 `baseURL` 自动发现模型**（实测：profile 里没配 `models:` 时 DSH 从头到尾不请求 `/v1/models`）。`models:` 段是插件 host 半边从网关 `GET /api/models` 拉到后写进静态 YAML 的「生成配置」，每 15 秒一次，写前备份。**装完只需要在面板里保存一次，之后全自动。**

`cb-gateway\tools\sync-profile-models.mjs` 是 v1 形态的历史脚本（按 `<通道>/v1/models` 逐通道拉），而 v2 已经没有通道前缀路由——**日常不要用它**。它只在「profile 里还留着 v1 按通道拆的 provider、想一次性重写那几段」时才有意义。

- 不带 `--write` 只预览；`--write` 会先把 `cordis.patch.yml` 备份成 `.bak-model-sync-*` 再写盘。认证从 `~\.dsh\cb-dsh\config.json` 读（**只认 `apiToken`，Basic 已删**）；网关地址默认 `http://127.0.0.1:7801`，由 `gatewayBase` 覆盖。它只是「不想开 DSH、一次性写盘」的兜底——平时由插件自动同步。
- 按 id 合并：`name` / `input` / `reasoningEfforts` 依据网关报的能力（`reasoning` / `input` / `reasoningEfforts`）重算，其它已有字段原样保留。
- **未登录 / 取不到目录时网关回空列表**（不是 500），脚本打印「0 个模型，跳过」——先把通道登录好再跑。
- 跑完**重启 DSH**（profile 启动时读一次）。

## 装到哪

- `%LOCALAPPDATA%\CreditBridge\gateway\` —— 网关代码 + `data\`（`config.json`、`accounts\` 凭据、`auth\` key 表、`logs\` 日志）
- `~\.dsh\profiles\desktop\` —— 插件副本 `node_modules\cb-dsh\` 与 provider 配置 `cordis.patch.yml`（都是安装时写进去的）
- `~\.dsh\cb-dsh\config.json` —— 面板的网关地址 + API key（面板自己写）

**别删解压目录**：profile 的 `file:` 依赖记的是这个 `.tgz` 的绝对路径，删了或移走后重装 / 升级会找不到文件，至少留着 `.tgz`。

## 卸载

`powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall`：从 profile `package.json` 删 `cb-dsh` 依赖和 `dsh.profile.bundles` 条目、删 `pnpm-lock.yaml`、跑一次 `pnpm install`；只停命令行确实指向 `CreditBridge` 目录的 7801 进程（否则放行，避免误杀）；删整个 `%LOCALAPPDATA%\CreditBridge` —— **含 `data\` 里的凭据与账本，卸载即删除**，想留先备份；提示重启 DSH。`cordis.patch.yml` 里的 provider 条目**不会自动删**（脚本只打印路径），需要手动删。

## 常见问题

- **`.ps1` 报 "not digitally signed"** —— 解压后被标记了，换个新目录重新解压，或 `Get-ChildItem -Recurse | Unblock-File`。
- **`/api/health` 返回 401 / 403** —— 没带 key，或还没改默认密码。先完成「装完必须手动做的三件事」。
- **安装脚本末尾报 "gateway did not answer on 7801 within 20s"** —— 现在探的是公开的 `/login`，正常情况下一定 200；真报这个说明网关没起来（看 `data\logs`），或者 `data\config.json` 的 `host` 不是 `127.0.0.1`、端口被占。
- **DSH 里模型列表是空的** —— 面板没保存成功（看面板下方的同步状态），或对应通道没登录。先去网关 `/accounts` 把号登好，再回面板点一次「保存」。
- **端口 7801 被占用** —— `install.ps1` 探公开的 `/login` 并检查页面里有没有「网关」字样来判断「是不是自己的网关」；不是自己的就 Fail 提示你手动停掉，是 DSH 托管的不杀（杀了它会用旧代码重启）。
- **改了上下文窗口没生效** —— profile 启动时读一次，重启 DSH。上下文窗口和思考强度都在网关的 `/models` 页改（存网关 `data/config.json` 的 `modelSettings`），插件只负责把 `/api/models` 照抄进 profile。
- **凭据安全** —— `data\accounts\` 是明文上游令牌、`data\auth\` 存 API key 明文（为了能回看），网关启动时会把这两个目录的 ACL 收紧到当前用户和 SYSTEM。`build.ps1` 有凭据扫描闸门，命中就把输出整个删掉；`providers.json` 另外单独校验不含本机专属键。

## 已知待修（打包链路与当前代码不同步，仅为现状记录）

1. ~~`packaging\extract-providers.mjs` 的白名单只有 `workbuddy` / `trae`，`packaging\build.ps1` 的 `$allowed` 同样只有两个，都没有第三个通道 `qoder`；分发包默认带不出 Qoder provider~~ 已修：v2 的 profile 里**只有一个**网关 provider（`baseURL` 路径正好 `/v1`），没有按通道拆的键了，所以白名单改成「按形态认」——extractor 抽那个 provider，`build.ps1` 改成校验「至少一项 + 不含本机专属键」。
2. ~~`extract-providers.mjs` 把本机 profile 的 provider 配置**整块复制**，连 `models:` 段和 `headers.Authorization` 一起带走~~ 已修：现在只产出**骨架**，`baseURL` / `apiKeyEnv` / `apiKey` / `models` / `headers` 一律剥离；`build.ps1` 另加一道独立校验（发现这五项就删产物并失败）。`merge-providers.mjs` 相应改成「保留收件人已填的本机字段，只更新展示字段」，重跑安装不会把地址和 key 抹掉。
   注意 `models:` 段**对 DSH 是必需的**（DSH 只从 profile 读模型，不会向 `baseURL` 发现；见 `tools/preflight-dsh.mjs` 第 2 节），v2 由插件 host 半边每 15 秒从**收件人自己的**网关同步，所以包里本来就不该带。
3. ~~`build.ps1` 的注释写「DSH 启动时从网关发现模型 / 新装的 profile 没有 `models:` 数组」，同一段还把 `Bearer local` 说成「网关忽略的占位符」~~ 已修：注释改成「DSH 只读 profile 的 `models:` 块，网关不再有通道前缀路由」，`Bearer local` 那段也改成「它是被认证闸拒绝的占位串」。
4. ~~`build-package.ps1` 的 SYNOPSIS 写产出 `dist\WorkBuddyForDSH-<version>-<date>.zip`（旧项目名）~~ 已修：现在写 `dist\CreditBridgeForDSH-<version>-<date>.zip`，与 `build.ps1` 实际产出一致。
5. ~~`install.ps1` 写 `data\config.json` 时还带 `ideVersion` / `appVersion` / `cliVersion` 三个已从 `AppConfig` 移除的全局版本字段~~ 已修：`install.ps1` 现在只写 `host` / `port` / `defaultContextWindow` / `defaultMaxTokens` / `verbose`。
6. ~~`cb-gateway\start.ps1` 里硬编码了打包机用户 `%USERPROFILE%\.dsh\dsh-runtimes\...\node.exe`，收件人机器上不存在，随包分发的 `start.ps1` 直接不可用~~ 已修：现在优先用这个 DSH 自带路径，找不到就退回 PATH 上的 `node`；探活也从已删的 `/health` 改成公开的 `/login`。
7. ~~`dist\CreditBridgeForDSH\` 是 2026-11-08 的旧产物~~ 已不在仓库：`dist/` 已被删除，且 `.gitignore` 排除，不再随版本库分发。
8. ~~`install.ps1` 检测 7801 端口时靠未认证 `/health` 返回里的 `gateway` 键判断「是不是自己」，但认证闸现在在 `/health` 前面，未登录会返回 401 → 已有本网关在跑时反而被判成「别的程序占用」而 Fail 退出~~ 已修：改探公开的 `/login`（200 且页面带「网关」才算自家），启动等待也改探 `/login`。摘要文案「Token centre panel」也已改成「积分桥」。
