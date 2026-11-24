// 插件的前端半边：在输入框右侧挂一个余额徽标，只在当前模型属于网关账号时显示。
//
// 徽标显示什么（数字 / 今日用量 / 通道名 / 图标）全由网关决定，这里只轮询
// `/api/accounts/<id>/badge` 并画出来。
//
// `inject: ["slots"]` 是必需的：没有它 apply() 会在 slots 服务存在之前跑，
// 注册失败且**不报错**。
window.__ModuleLoader__.load({
  id: "cb-dsh",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");

    // 网关地址。**故意是 let 而不是 const**：十几处调用都写成 `GATEWAY + "/xxx"`，
    // 把它变成可变量之后，一次配置刷新就全部跟着生效，不用逐个改成函数调用。
    //
    // 启动先用默认值，紧接着向 control 服务要一次真值（见下方 loadGatewayBase）。
    let GATEWAY = "http://127.0.0.1:7801";

    /**
     * 控制服务（host 半边，本机 HTTP）。
     *
     * **地址不能写死 `http://127.0.0.1:7802`**：面板也会在**别人的浏览器**里打开——
     * 手机连 `http://192.168.1.10:3081` 时，页面脚本里的 `127.0.0.1` 指的是手机自己，
     * 保存、同步于是全部 `Failed to fetch`（2026-11 实测踩到，面板显示
     * 「保存失败：Failed to fetch」）。
     *
     * 所以按下面的顺序找它：
     *
     *   1. **同源前缀 `/__cb-dsh/`**——手机经 nginx 进来时唯一可行的路径。控制服务
     *      本身只听环回，由 nginx 反代过来（见 dsh-lan/sync-cookie.ps1），不把控制面
     *      暴露到局域网。
     *   2. **页面主机名的 7802…7811**——本机直开就是 127.0.0.1:7802；同一台机器有多个
     *      DSH 实例时，后起的 host 半边会顺延端口，所以按顺序探。
     */
    const CONTROL_PREFIX = "/__cb-dsh";
    /**
     * 控制服务的主机名。
     *
     * **只接受 IP 字面量 / localhost**，其余一律回落 `127.0.0.1`。
     *
     * 2026-11-11 实测：DSH 桌面版的渲染进程跑在自定义协议 `dsh-app://app` 下，
     * `location.hostname` 是 **`"app"`**（协议名，不是主机），于是拼出
     * `http://app:7802` —— 一个不存在的主机名，11 个端口全探失败，
     * `CONTROL` 停在初始值，面板保存时报「Failed to fetch」。
     * 早先只处理了「hostname 为空」，没处理「hostname 是协议名」。
     *
     * 判据和网关 host 闸（`app.ts` 的 loopbackHost / hostAllowed）保持一致：
     * 只有 `127.x.x.x` / 其它 IPv4 / `[::1]` / `localhost` 才算「页面在某台机器上，
     * 控制服务就在那台机器的环回」。手机经 nginx 进来时 hostname 是 `192.168.1.10`，
     * 仍然按原样用（这时走的是同源前缀，用不到它）。
     */
    const CONTROL_HOST = (function () {
      try {
        const host = typeof location !== "undefined" ? String(location.hostname || "") : "";
        if (host === "") return "127.0.0.1";
        if (host === "localhost") return host;
        if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return host;
        if (/^\[[0-9a-f:.]+\]$/i.test(host)) return host;
        // 自定义协议（dsh-app://app）或任何域名：不是本机 IP，回落环回。
        return "127.0.0.1";
      } catch {
        return "127.0.0.1";
      }
    })();
    const CONTROL_PORTS = [7802, 7803, 7804, 7805, 7806, 7807, 7808, 7809, 7810, 7811];
    let CONTROL = "http://" + CONTROL_HOST + ":7802";

    /** 这个 URL 是不是发往控制服务的（是就不加网关的 Bearer 头）。 */
    function isControlUrl(url) {
      const value = String(url);
      if (value.startsWith(CONTROL)) return true;
      // 控制服务的端口是 7802…7811，不能只按主机名判：本机网关就在同一台机器的
      // 7801 上（默认值），按主机名会把网关请求当成控制服务、把 Bearer 头吃掉，
      // 结果是徽标一直 401。
      //
      // **端口后面必须跟边界**（`/`、`?`、`#` 或结尾）。写成
      // `startsWith("http://host:" + port)` 会把 `:78020` 也算成 `:7802`——那是另一
      // 个服务，同样会吃掉不该加的头。
      const escapedHost = CONTROL_HOST.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const withControlPort = new RegExp("^http://" + escapedHost + ":(?:" + CONTROL_PORTS.join("|") + ")(?:[/?#]|$)");
      if (withControlPort.test(value)) return true;
      try {
        return value.startsWith(location.origin + CONTROL_PREFIX);
      } catch {
        return false;
      }
    }

    /** 试一个 base 能不能回 /config；能就采纳。 */
    async function probeControl(base) {
      try {
        const response = await fetch(base + "/config", {
          cache: "no-store",
          signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(1500) : undefined,
        });
        const doc = await response.json();
        if (!doc || !doc.ok) return false;
        CONTROL = base;
        return true;
      } catch {
        return false;
      }
    }

    /**
     * 先试同源反代前缀，再试 CONTROL_HOST 的 7802…7811。
     *
     * 同源前缀只在页面走 http(s) 时有意义（手机经 nginx 进来那种）。DSH 桌面版跑在
     * `dsh-app://` 下，那个 origin 后面根本没有反代，探它只会白等一次 1.5 秒超时，
     * 所以按协议跳过。
     */
    async function discoverControl() {
      const tried = [];
      try {
        const isHttpPage =
          typeof location !== "undefined" && (location.protocol === "http:" || location.protocol === "https:");
        if (isHttpPage && location.origin) {
          const probeUrl = location.origin + CONTROL_PREFIX;
          const hit = await probeControl(probeUrl);
          tried.push(probeUrl + "=" + (hit ? "ok" : "no"));
          if (hit) return true;
        }
      } catch (e) {
        tried.push("origin-probe-error:" + String(e && e.message ? e.message : e));
      }
      for (const port of CONTROL_PORTS) {
        const base = "http://" + CONTROL_HOST + ":" + port;
        const hit = await probeControl(base);
        tried.push(base + "=" + (hit ? "ok" : "no"));
        if (hit) return true;
      }
      // 全都失败：把面板侧看到的 origin / hostname / 每个探测结果报给 host，写进日志。
      // 这是排查 `Failed to fetch` 唯一能看到「面板到底试了什么」的途径。
      try {
        const diag = JSON.stringify({
          origin: typeof location !== "undefined" ? location.origin : null,
          hostname: typeof location !== "undefined" ? location.hostname : null,
          protocol: typeof location !== "undefined" ? location.protocol : null,
          CONTROL_HOST: CONTROL_HOST,
          tried: tried,
        });
        fetch(CONTROL + "/diag", { method: "POST", cache: "no-store", body: diag }).catch(() => {});
        // CONTROL 可能本身就是坏的，再退一步直连默认端口报一次。
        if (CONTROL !== "http://127.0.0.1:7802") {
          fetch("http://127.0.0.1:7802/diag", { method: "POST", cache: "no-store", body: diag }).catch(() => {});
        }
      } catch {
        /* 诊断失败不影响功能 */
      }
      return false;
    }

    const REFRESH_MS = 60000;

    /** 把控制服务给的地址装上；不合法就保留原样，别把面板弄成打不开。返回是否真的变了。 */
    function applyGatewayBase(raw) {
      if (typeof raw !== "string") return false;
      const value = raw.trim().replace(/\/+$/, "");
      if (!/^https?:\/\/[^\s/]+/i.test(value)) return false;
      const changed = GATEWAY !== value;
      GATEWAY = value;
      return changed;
    }

    /**
     * 网关凭据：**只有 API key 一种**。
     *
     * v2 E 阶段把 Basic 认证删了（见 cb-gateway/private/docs/v2 §5）。用户名密码只用于**人**
     * 登录网关网页；程序——包括这个面板——一律用 `/keys` 页发的 `sk-…` key。
     * 分成两类是因为生命周期不同：改密码不该让面板掉线，吊销 key 也不该让人退出登录。
     *
     * 早先这里支持「填用户名密码走 Basic」，那条路现在只会 401，删掉了。
     */
    let API_TOKEN = "";

    /**
     * 有没有配好网关（地址 + key 都有）。
     *
     * 三态，`null` = 还没问到控制服务。**不能默认 `false`**：那样面板刚挂载的一瞬间
     * 会把「未配置」闪一下，已配好的用户会以为配置丢了。`null` 时按老行为去试，
     * 只有明确知道没配才切到「未配置」。
     */
    let CONFIGURED = null;

    /**
     * 所有发往网关的请求都走这里，统一挂认证头。
     *
     * 为什么不改每个调用点：请求分散在五处（health / channels / badge /
     * badge / plugin-probe），逐个加头必然漏一个，而漏掉的表现是「面板某一块
     * 莫名其妙 401」，很难查。CONTROL 是本机 7802，不是网关，不加头。
     */
    function gwFetch(url, init) {
      const options = Object.assign({}, init);
      // 控制服务不加网关的 Bearer 头。判断走 isControlUrl：它同时认「直连控制端口」
      // 和「同源反代前缀」两种形态（手机走后者）。
      if (!isControlUrl(url)) {
        options.headers = Object.assign({}, init && init.headers, {
          Authorization: "Bearer " + API_TOKEN,
        });
      }
      return fetch(url, options);
    }

    /**
     * 从 control 服务取一次网关地址。
     *
     * 启动时调一次（紧接 `discoverControl()`），之后配置变化靠
     * `cb-dsh-config-changed` 广播让徽标立刻重试，所以用户改了地址之后不用重开面板。
     * 失败就静默保留当前值；真失败（比如 DSH 刚启动、或端口还在探测）也不该让
     * 徽标变成错误状态。
     */
    function loadGatewayBase() {
      return fetch(CONTROL + "/config", { cache: "no-store" })
        .then((response) => response.json())
        .then((doc) => {
          if (!doc || !doc.ok) return;
          // 地址或 key **任一**变了都要广播（原来写成 && ，只有两者同时变才通知，
          // 只改 key 时徽标会拖到下一次 60 秒轮询）。
          const baseChanged = applyGatewayBase(doc.gatewayBase);
          const tokenChanged = typeof doc.apiToken === "string" ? doc.apiToken !== API_TOKEN : false;
          // 凭据和地址一起从控制服务读：都是「网关在哪、怎么进」的一部分。
          if (typeof doc.apiToken === "string") API_TOKEN = doc.apiToken;
          if (typeof doc.configured === "boolean") CONFIGURED = doc.configured;
          // **地址或 key 变了要立刻通知徽标重来**：徽标组件挂载时可能比
          // `discoverControl()` 先跑（那时 API_TOKEN 还是空），只能等 60 秒轮询。
          // 2026-11-11 用户看到「保存成功但徽标还是离线」就是这么来的——配置明明
          // 已经更新，徽标却要等下一轮。广播一次，它立刻重试。
          if (baseChanged || tokenChanged) {
            try {
              window.dispatchEvent(new CustomEvent("cb-dsh-config-changed"));
            } catch {
              /* 没有 window 就算了 */
            }
          }
        })
        .catch(() => {});
    }
    // **先探端口再读配置**：多实例时后起的那个 host 半边会顺延端口，
    // 直接打 7802 会打到别的实例上（读到别人的配置，或者根本没人监听）。
    discoverControl().finally(() => {
      loadGatewayBase();
    });

    /**
     * 徽标点进去的目标：**账号详情页**。
     *
     * 入参是账号 id（`wb-1`），从模型 id 的前半段拆出来——不是 DSH 的 provider
     * 路由名（`jf`），也不是通道 id（`workbuddy`）。v2 没有 `?provider=` 那种问法了，
     * 账号有自己的页面 `/accounts/<账号 id>`。
     */
    function panelUrlFor(accountId) {
      if (!accountId) return GATEWAY + "/accounts";
      return GATEWAY + "/accounts/" + encodeURIComponent(accountId);
    }

    function probe(stage) {
      try {
        gwFetch(GATEWAY + "/api/plugin-probe?stage=" + encodeURIComponent(stage), { cache: "no-store" }).catch(() => {});
      } catch {
        /* diagnostics only */
      }
    }
    probe("factory");

    /**
     * 在**用户这台机器**上打开一个外部地址。
     *
     * 第一选择是 `window.open(url, "_blank", "noopener,noreferrer")`——这正是 DSH
     * 自己打开 Markdown 外链的写法（dsh-client-ui-chat 里 `openExternalLink`），
     * 宿主会把 `_blank` 交给系统浏览器。第二选择才是造一个真实的
     * `<a target="_blank">` 点一下：`window.open` 被拦时导航不一定被拦，两条路
     * 走的是同一个 setWindowOpenHandler，但触发点不同，值得都试。
     *
     * 锚点**不能**用 `display:none`：某些引擎会忽略不可渲染元素上的合成点击。
     * 这里改成移到屏幕外，点完延后移除——立刻移除有可能把正在进行的导航一起丢掉。
     *
     * 为什么不能靠网关去开：**网关根本不打开浏览器**。它是无头服务，容器/服务器上
     * 那台机器没有浏览器；浏览器本来就在用户这台机器上。
     *
     * 返回「是否发起成功」；两条路都失败时调用方会提示用户手动点链接。
     */
    const chipStyle = {
      display: "inline-flex",
      alignItems: "center",
      gap: "6px",
      height: "24px",
      padding: "0 8px",
      border: "1px solid var(--dsh-border-color, rgba(0,0,0,0.12))",
      borderRadius: "12px",
      background: "transparent",
      color: "var(--dsh-color-text-secondary, #666)",
      font: "inherit",
      fontSize: "12px",
      lineHeight: "1",
      cursor: "pointer",
      whiteSpace: "nowrap",
      textDecoration: "none",
    };


    function CreditsStrip(props) {
      const modelId = props && props.modelId ? props.modelId : null;
      // `provider` 是 DSH 的**路由名**（profile 里 `providers:` 的键，比如 `jf`），
      // 不是通道 id，也不是账号 id。同一个 provider 下挂着**所有账号的所有模型**
      // （`wb-1/hy4free` 和 `tr-1/glm-5.3` 都在它底下），所以「这是哪个通道 / 哪个
      // 账号」只能从**模型 id** 里拆：`<账号 id>/<上游模型 id>`。
      const provider = (props && props.provider) || "";
      const accountId = String(modelId || "").split("/")[0] || "";
      // 徽标要显示的东西（主数字 + 今日用量）都在网关那边算好，这里只存那一份。
      const [state, setState] = React.useState({ badge: null });
      // 通道图标：模块级缓存，这里只订阅结果。
      const [icons, setIcons] = React.useState(null);
      // 上一次探活有没有打通网关。只用来决定徽标显示「离线」还是数字——
      // 启停已经不在插件里了（归 docker compose），所以这里没有「已关闭」这个状态，
      // 只有「连不上」。
      const [powerState, setPowerState] = React.useState("unknown"); // "unknown" | "running" | "stopped"
      /**
       * 面板里刚配好要让徽标立刻反映出来，不能被 60 秒轮询卡住。
       * 组件自己存一份，配合下面的 `cb-dsh-config-changed` 事件刷新。
       */
      const [configuredState, setConfiguredState] = React.useState(CONFIGURED);

      const refresh = React.useCallback(async () => {
        setConfiguredState(CONFIGURED);
        // 没配置网关就别发请求：打出去只会得到 401 / connection refused，
        // 徽标显示「离线」——而真相是「你还没配」，两句话差得很远。
        if (CONFIGURED === false) {
          setPowerState("stopped");
          return;
        }
        try {
          // v2 的余额和账本都是账号维度的路径，没有 ?provider= 这种问法了。
          // 拿不到账号 id 就别发请求——打一条注定 404 的请求只会让徽标显示「离线」。
          if (!accountId) throw new Error("模型 id 里没有账号段");
          // **一次请求拿全部文案**：主数字和「今日」怎么显示取决于通道的计费方式
          // （积分 / token / 请求次数），那是通道语义，网关算好再给（core/badge.ts）。
          // 早先这里发两个请求、在前端自己算，结果是每加一个计费方式不同的通道都要
          // 改插件。
          const response = await gwFetch(GATEWAY + "/api/accounts/" + encodeURIComponent(accountId) + "/badge", {
            cache: "no-store",
          });
          if (!response.ok) throw new Error("HTTP " + response.status);
          setState({ badge: await response.json() });
          setPowerState("running");
          probe("fetch-ok");
        } catch (error) {
          // Keep the last good numbers on screen: a single failed poll should
          // not blank the balance. The 离线 label carries the bad news.
          setPowerState("stopped");
          probe("fetch-error");
        }
      }, [accountId]);

      // 图标表单独取：它按通道缓存，不跟着 60 秒轮询走。
      React.useEffect(() => {
        let alive = true;
        ensureChannelIcons().then((next) => {
          if (alive) setIcons(next);
        });
        return () => {
          alive = false;
        };
      }, []);

      React.useEffect(() => {
        probe("mount");
        refresh();
        const timer = setInterval(refresh, REFRESH_MS);
        // 面板保存成功后广播一次，徽标立刻按新配置重来，不用等下一轮轮询。
        const onConfigChanged = () => refresh();
        try {
          window.addEventListener("cb-dsh-config-changed", onConfigChanged);
        } catch {
          /* 没有 window 就算了（不该发生，但别把徽标弄挂） */
        }
        return () => {
          clearInterval(timer);
          try {
            window.removeEventListener("cb-dsh-config-changed", onConfigChanged);
          } catch {
            /* ignore */
          }
        };
      }, [refresh]);

      // "unknown" = 第一次探活还没回来。文字上按「在线」渲染（避免每次挂载都闪一下
      // 开/离线），但**链接不能按在线给**：此刻 GATEWAY 可能还是模块顶部那个默认值
      // （`http://127.0.0.1:7801`），点下去会跳到一个根本不存在的本机网关。
      // 只有真正要到了数字/powerState 变 running，才说明地址是被验证过的。
      //
      // **没配置网关时这三个都不成立**：不是「离线」（那是在说网关没开），而是
      // 「你还没告诉我去哪」——所以单独一档，链接也不给。
      const unconfigured = configuredState === false;
      const online = !unconfigured && powerState !== "stopped";
      const linked = !unconfigured && powerState === "running";

      const badge = state.badge;
      // 短标签只留「数字 / 状态」，通道是哪个由左边的图标说明。
      const label = unconfigured ? "未配置" : !online ? "离线" : (badge && badge.amount) || "已连接";
      // 「今日」的取舍（有积分显示积分、免费模型显示 token、否则显示次数）由网关决定，
      // 插件只负责「有就画、没有就不画」。
      const today = !unconfigured && online && badge && badge.today ? badge.today : "";
      // 通道名由网关在 badge 里回（通道自己的 label），缺了才退回 provider 路由名。
      const displayName = (badge && badge.title) || provider;
      // 按**通道 id** 取图标：badge 里的 `channel` 是通道 id（`workbuddy`），
      // 而函数入参那个 `provider` 是 DSH 的路由名（`jf`），两者不是一个东西。
      const iconEntry = badge && badge.channel && icons ? icons[badge.channel] : null;
      // 徽标点进那个账号的详情页：v2 的账号有独立页面 `/accounts/<账号 id>`。
      const panelUrl = panelUrlFor(accountId);

      return React.createElement(
        "span",
        { style: { display: "inline-flex", alignItems: "center", gap: "4px", marginRight: "4px" } },
        // The badge is the panel entry: clicking it opens the gateway
        // dashboard. A plain anchor (not a click handler) so DSH's own
        // setWindowOpenHandler routes it to the system browser — an in-window
        // navigation here would replace the DSH app itself.
        React.createElement(
          "a",
          {
            href: linked ? panelUrl : undefined,
            target: "_blank",
            rel: "noreferrer",
            style: Object.assign({}, chipStyle, linked ? null : { cursor: "default" }),
          },
          // 图标是网关给的 data URI（`/api/channels`）。用 data URI 而不是直连网关：
          // 插件跑在 dsh-app:// 下，img-src 放不放行网关源没有验证过，而 data URI
          // 一直是通的。图标缺失时退回首字母，**不再直接留白**。
          iconEntry && iconEntry.icon
            ? React.createElement("img", {
                src: iconEntry.icon,
                alt: displayName,
                width: 14,
                height: 14,
                style: { display: "block", borderRadius: "3px" },
              })
            : iconEntry && iconEntry.letter
              ? React.createElement(
                  "span",
                  {
                    "aria-hidden": "true",
                    style: {
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: "14px",
                      height: "14px",
                      borderRadius: "3px",
                      background: "var(--dsh-color-fill-secondary, rgba(0,0,0,0.08))",
                      color: "var(--dsh-color-text-secondary, #666)",
                      fontSize: "9px",
                      fontWeight: "600",
                      lineHeight: "1",
                    },
                  },
                  iconEntry.letter,
                )
              : null,
          React.createElement("span", { style: { color: "var(--dsh-color-text-tertiary, #999)" } }, label),
          badge && badge.note ? React.createElement("span", { title: badge.note, style: { cursor: "help" } }, "ⓘ") : null,
          today ? React.createElement("span", null, today) : null,
        ),
      );
    }

    // ---------------------------------------------------------------- panel
    //
    // The sidebar row and the page it opens share one id: `sidebar.panellist`
    // takes it as `id` and the layout's `main` keyed slot takes it as `key`, so
    // selecting the row switches the main panel to this component.
    // Order 5 sits between Plugins (0) and Automation tasks (10).
    const SETTINGS_PANEL_ID = "dsh-credits";

    // Display name for the sidebar row and the page heading. One place so the
    // two never drift.
    const PANEL_TITLE = "积分桥";

    /**
     * 通道图标：`通道 id → data URI`，由网关的 `/api/channels` 一次给全。
     *
     * **为什么不在插件里内联**：图标是通道的资产，和 `label` / `idPrefix` 一样该由
     * 通道自己带。以前这里是三行 base64 常量表，加通道要改插件、重新打包；漏了还
     * 不会报错——Loomy 上线后徽标一直没有图标，就是这张表里少了一行，而注释还写着
     * 「缺了会退回名字首字母」，实际什么都不显示。
     *
     * 一次取全、常驻内存：图标不会变，没必要每个徽标各取一遍。
     * `base` 记下来是为了「再调用时发现地址换了就重取」；目前只在 `CreditsStrip`
     * 挂载时调一次，所以改网关地址后要等徽标重挂载才会换图。
     */
    const channelIcons = { base: null, icons: null, pending: null };

    /**
     * 取图标表。并发调用共用同一个 promise，所以 N 个徽标也只会打一次网关。
     *
     * 失败不缓存（`icons` 保持 null），下一轮调用会重试；徽标本身此时显示「离线」，
     * 不需要图标。
     */
    function ensureChannelIcons() {
      if (channelIcons.base === GATEWAY && channelIcons.icons) {
        return Promise.resolve(channelIcons.icons);
      }
      if (channelIcons.base === GATEWAY && channelIcons.pending) return channelIcons.pending;
      channelIcons.base = GATEWAY;
      channelIcons.icons = null;
      channelIcons.pending = gwFetch(GATEWAY + "/api/channels", { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then((doc) => {
          const icons = {};
          for (const channel of (doc && doc.channels) || []) {
            if (!channel || !channel.id) continue;
            // 缺图标的通道也留一项 `letter`：兜底字母由网关按 `label` 算好，
            // 前端不用再猜「取哪个字段的第一个字」。
            icons[channel.id] = { icon: channel.icon || null, letter: channel.letter || null };
          }
          channelIcons.icons = icons;
          channelIcons.pending = null;
          return icons;
        })
        .catch(() => {
          channelIcons.pending = null;
          channelIcons.icons = null;
          return {};
        });
      return channelIcons.pending;
    }

    /** Gear glyph; `size` is the edge the sidebar asks for. */
    function SettingsPanelIcon({ size }) {
      const edge = typeof size === "number" && size > 0 ? size : 16;
      return React.createElement(
        "svg",
        {
          width: edge,
          height: edge,
          viewBox: "0 0 16 16",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.4,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
        },
        React.createElement("circle", { cx: 8, cy: 8, r: 2.1 }),
        React.createElement("path", {
          d: "M8 1.9v1.5M8 12.6v1.5M1.9 8h1.5M12.6 8h1.5M3.7 3.7l1 1M11.3 11.3l1 1M12.3 3.7l-1 1M4.7 11.3l-1 1",
        }),
      );
    }

    const cardStyle = {
      border: "1px solid var(--dsh-border-color, rgba(0,0,0,0.1))",
      borderRadius: "10px",
      padding: "14px 16px",
      marginBottom: "12px",
    };

    /**
     * 设置面板：**只有三样东西**——网关地址、API key、保存。
     *
     * 这里原来是「各通道额度 + 每日签到 + 登录/退出 + 模型列表开关」，那是 v1 的形状：
     * 通道前缀路由、按通道的登录态、按通道的模型清单。v2 把这些全部收进了网关网页
     * （`/accounts` 管账号和登录、`/models` 管可见性、`/` 看余额），插件再摆一份就是
     * 两套要同时维护的界面，而且很容易只改一边。
     *
     * 现在插件的职责收窄成一条：**把「网关在哪、用什么 key」写进配置，并把结果落到
     * DSH 自己的 profile 上**——让用户填完点保存，模型选择器里就直接有东西可用。
     * 这是插件不可替代的部分：网关在容器里，看不到这台机器的 profile。
     *
     * 余额没丢：输入框右侧那个积分徽标（`CreditsStrip`）还在，它回答「这次对话花谁的
     * 钱」；要看全部账号去网关网页。
     */
    function SettingsPanel() {
      const [gatewayDraft, setGatewayDraft] = React.useState("");
      const [tokenDraft, setTokenDraft] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [note, setNote] = React.useState(null); // { kind: "ok"|"bad"|"info", text }
      const [syncState, setSyncState] = React.useState(null);
      /** 网关有没有配好（地址 + key）。`null` = 还没问到，别急着下结论。 */
      const [configured, setConfigured] = React.useState(CONFIGURED);

      /** 保存成功后广播：徽标立刻按新配置重来，不用等 60 秒轮询。 */
      function announceConfigChanged() {
        try {
          window.dispatchEvent(new Event("cb-dsh-config-changed"));
        } catch {
          /* 没有 window 就算了 */
        }
      }

      /** 挂载时把已保存的值填进输入框。只做一次——放进轮询会冲掉正在输入的内容。 */
      React.useEffect(() => {
        fetch(CONTROL + "/config", { cache: "no-store" })
          .then((response) => response.json())
          .then((doc) => {
            if (!doc || !doc.ok) return;
            const base = doc.gatewayBase || GATEWAY;
            applyGatewayBase(base);
            setGatewayDraft(base);
            if (typeof doc.apiToken === "string") {
              API_TOKEN = doc.apiToken;
              setTokenDraft(doc.apiToken);
            }
            if (typeof doc.configured === "boolean") {
              CONFIGURED = doc.configured;
              setConfigured(doc.configured);
            }
          })
          .catch(() => {});
        fetch(CONTROL + "/model-sync", { cache: "no-store" })
          .then((response) => response.json())
          .then((doc) => {
            if (doc && doc.ok && doc.state) setSyncState(doc.state);
          })
          .catch(() => {});
      }, []);

      /**
       * 保存 = 存配置 + 写 profile + 同步模型，三件事由 host 半边的 `/setup` 一次做完。
       *
       * 不在前端分三步调：那样中途失败会留下「配置存了但 profile 没写」的中间态，
       * 而用户看到的是「保存成功了」。
       */
      const save = React.useCallback(async () => {
        if (busy) return;
        const value = String(gatewayDraft || "").trim().replace(/\/+$/, "");
        if (!/^https?:\/\/[^\s/]+/i.test(value)) {
          setNote({ kind: "bad", text: "地址要写成 http://主机:端口" });
          return;
        }
        const token = String(tokenDraft || "").trim();
        if (!token) {
          setNote({ kind: "bad", text: "先填 API key（在网关 /keys 页创建）" });
          return;
        }

        setBusy(true);
        setNote({ kind: "info", text: "正在写入 DSH 配置…" });
        try {
          const response = await fetch(CONTROL + "/setup", {
            method: "POST",
            cache: "no-store",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ gatewayBase: value, apiToken: token }),
          });
          const doc = await response.json().catch(() => ({}));
          if (!response.ok || !doc.ok) {
            throw new Error(doc.error || (doc.sync && doc.sync.error) || "HTTP " + response.status);
          }

          applyGatewayBase(doc.gatewayBase || value);
          setGatewayDraft(doc.gatewayBase || value);
          API_TOKEN = token;
          // 保存成功 = 两项都齐了，配置状态翻成 true（host 也会在响应里回）。
          const nowConfigured = typeof doc.configured === "boolean" ? doc.configured : Boolean(value && token);
          CONFIGURED = nowConfigured;
          setConfigured(nowConfigured);
          announceConfigChanged();
          if (doc.sync) setSyncState(doc.sync);

          const providerAction = doc.provider && doc.provider.action === "created" ? "新建了 provider" : "更新了 provider";
          const ref = doc.credentialRef ? "，key 已存进 DSH 凭据库（" + doc.credentialRef + "）" : "";
          const saved = providerAction + ref + "。";

          // 模型同步失败不等于保存失败：地址和 key 都已经落盘、profile 也改好了，
          // 只是拉模型那一步没通。分开说，别让人以为白填了。
          if (doc.sync && doc.sync.ok === false) {
            setNote({
              kind: "warn",
              text:
                saved +
                "但拉模型失败：" +
                String(doc.sync.error || "未知原因").slice(0, 160) +
                "。地址和 key 已经存好，常见原因是这把 key 无效或网关没起来；修好后点一次「保存」重试。",
            });
            return;
          }

          const wrote = doc.sync && doc.sync.wrote;
          const count = doc.sync && typeof doc.sync.models === "number" ? doc.sync.models : 0;
          setNote({
            kind: "ok",
            text:
              saved +
              (wrote ? "已写入 " + count + " 个模型。" : "模型清单没有变化。") +
              "**重启 DSH 后生效**（模型清单是启动时读的）。",
          });
        } catch (error) {
          const message = String(error && error.message ? error.message : error);
          setNote({ kind: "bad", text: "保存失败：" + message.slice(0, 200) });
        } finally {
          setBusy(false);
        }
      }, [busy, gatewayDraft, tokenDraft]);

      const noteColor =
        note && note.kind === "ok"
          ? "var(--dsh-color-success, #2f8f4e)"
          : note && note.kind === "warn"
            ? "var(--dsh-color-warning, #9a5b00)"
            : note && note.kind === "bad"
              ? "var(--dsh-color-danger, #c0392b)"
              : "var(--dsh-text-secondary, #666)";

      const fieldStyle = {
        flex: 1,
        minWidth: 0,
        padding: "6px 10px",
        font: "inherit",
        fontSize: "13px",
        lineHeight: "18px",
        borderRadius: "7px",
        border: "1px solid var(--dsh-border-color, rgba(0,0,0,0.14))",
        background: "transparent",
        color: "inherit",
      };
      const buttonStyle = {
        padding: "6px 16px",
        font: "inherit",
        fontSize: "13px",
        borderRadius: "7px",
        border: "1px solid transparent",
        background: "var(--dsh-color-accent, #3a6df0)",
        color: "#fff",
        cursor: busy ? "default" : "pointer",
        opacity: busy ? 0.6 : 1,
      };

      const syncLine = syncState
        ? syncState.ok === false
          ? "上次同步失败：" + String(syncState.error || "").slice(0, 80)
          : syncState.at
            ? "上次同步：" + new Date(syncState.at).toLocaleTimeString("zh-CN", { hour12: false }) + " · " + (syncState.models || 0) + " 个模型"
            : "还没同步过"
        : "还没同步过";

      return React.createElement(
        "div",
        {
          style: {
            height: "100%",
            overflow: "auto",
            padding: "calc(var(--dsh-frame-top-clearance, 0px) + 28px) 32px 40px",
          },
        },
        React.createElement(
          "div",
          { style: { maxWidth: "640px" } },
          React.createElement(
            "h1",
            { style: { fontSize: "20px", lineHeight: "28px", margin: "0 0 4px", fontWeight: 600 } },
            PANEL_TITLE,
          ),
          React.createElement(
            "p",
            { style: { margin: "0 0 20px", color: "var(--dsh-text-secondary, #666)", fontSize: "13px", lineHeight: "20px" } },
            "填网关地址和 API key，保存后自动写进 DSH 配置。",
          ),

          // 没配好时给一条明确的横幅：这时候徽标显示「未配置」、模型列表是空的，
          // 不解释一句的话用户会以为插件坏了。
          configured === false
            ? React.createElement(
                "p",
                {
                  style: {
                    margin: "0 0 16px",
                    padding: "10px 12px",
                    borderRadius: "8px",
                    background: "var(--dsh-color-warning-bg, #fff8e6)",
                    border: "1px solid var(--dsh-color-warning-border, #f0d9a8)",
                    color: "var(--dsh-color-warning-text, #8a5a00)",
                    fontSize: "13px",
                    lineHeight: "20px",
                  },
                },
                "还没配置网关。填好下面两项并点「保存」，模型列表和积分徽标才会生效。",
              )
            : null,

          React.createElement(
            "div",
            { style: cardStyle },
            React.createElement("div", { style: { fontSize: "14px", lineHeight: "22px", marginBottom: "12px" } }, "连接"),

            React.createElement(
              "div",
              { style: { display: "flex", alignItems: "center", gap: "8px" } },
              React.createElement("span", { style: { width: "64px", flexShrink: 0, color: "var(--dsh-text-secondary, #666)", fontSize: "13px" } }, "网关地址"),
              React.createElement("input", {
                type: "text",
                value: gatewayDraft,
                spellCheck: false,
                placeholder: "http://主机:端口",
                onChange: (event) => setGatewayDraft(event && event.target ? event.target.value : ""),
                onKeyDown: (event) => {
                  if (event && event.key === "Enter") save();
                },
                style: fieldStyle,
              }),
            ),

            React.createElement(
              "div",
              { style: { display: "flex", alignItems: "center", gap: "8px", marginTop: "8px" } },
              React.createElement("span", { style: { width: "64px", flexShrink: 0, color: "var(--dsh-text-secondary, #666)", fontSize: "13px" } }, "API key"),
              React.createElement("input", {
                type: "password",
                value: tokenDraft,
                spellCheck: false,
                placeholder: "sk-…（在网关 /keys 页创建）",
                onChange: (event) => setTokenDraft(event && event.target ? event.target.value : ""),
                onKeyDown: (event) => {
                  if (event && event.key === "Enter") save();
                },
                style: fieldStyle,
              }),
              React.createElement("button", { type: "button", onClick: save, disabled: busy, style: buttonStyle }, busy ? "保存中…" : "保存"),
            ),

            note
              ? React.createElement(
                  "p",
                  { style: { margin: "12px 0 0", fontSize: "13px", lineHeight: "20px", color: noteColor } },
                  note.text,
                )
              : null,

            React.createElement(
              "p",
              { style: { margin: "12px 0 0", fontSize: "12px", lineHeight: "18px", color: "var(--dsh-text-secondary, #666)" } },
              syncLine,
            ),
          ),

          React.createElement(
            "div",
            { style: cardStyle },
            React.createElement("div", { style: { fontSize: "14px", lineHeight: "22px", marginBottom: "8px" } }, "其余都在网关里"),
            React.createElement(
              "p",
              { style: { margin: "0 0 10px", fontSize: "13px", lineHeight: "20px", color: "var(--dsh-text-secondary, #666)" } },
              "账号登录、余额、模型可见性、API key 管理都在网关网页，这里只负责把 DSH 接上。",
            ),
            React.createElement(
              "a",
              {
                href: GATEWAY + "/",
                target: "_blank",
                rel: "noreferrer",
                style: { fontSize: "13px", color: "var(--dsh-color-accent, #3a6df0)", textDecoration: "none" },
              },
              "打开网关 → " + GATEWAY.replace(/^https?:\/\//i, ""),
            ),
          ),
        ),
      );
    }


    /**
     * Gate the strip on the session's selected model. `directory` is the
     * model-directories store for this session: `getSnapshot().current` is
     * `{ provider, model }` or null.
     *
     * **`provider` 是 DSH 的路由名，不是通道 id。** v2 的 profile 里只有一个
     * 网关 provider（`jf` / `qb`），它底下挂着三家通道所有账号的所有模型——
     * 所以「这个模型是不是网关的」不能拿 provider 名去比对通道清单，那两边
     * 永远不会相等，徽标就一个都不显示（2026-11 之前就是这样坏的）。
     *
     * 正确的判据在模型 id 上：`<账号 id>/<上游模型 id>`，账号 id 必须出现在
     * 网关的账号清单里。清单从 `/api/health` 的 `accounts` 拿（它只读本地状态、
     * 不发网络请求，适合被反复调用）。
     *
     * 清单到手之前（第一帧）先显示：DSH 官方模型 id 不带 `/`，误显示的代价只是
     * 一个徽标闪一下；反过来「一律不显示」会让首屏永远空白。网关不可达时清单
     * 保持 `null` 并按 `REFRESH_MS` 重试，恢复后徽标会自己回来。
     */
    function CreditsGate({ directory }) {
      const subscribe = React.useCallback((listener) => directory.subscribe(listener), [directory]);
      const getSnapshot = React.useCallback(() => directory.getSnapshot(), [directory]);
      const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
      // null = 还不知道有哪些账号（首帧 / 网关没连上）
      const [accounts, setAccounts] = React.useState(null);
      const selection = snapshot && snapshot.current;

      React.useEffect(() => {
        let alive = true;
        let timer = null;
        const load = () => {
          gwFetch(GATEWAY + "/api/health", { cache: "no-store" })
            .then((response) => (response.ok ? response.json() : null))
            .then((doc) => {
              if (!alive) return;
              if (doc && Array.isArray(doc.accounts)) {
                setAccounts(doc.accounts.map((account) => account && account.id).filter(Boolean));
                return; // 拿到了就不必再轮询
              }
              timer = setTimeout(load, REFRESH_MS);
            })
            .catch(() => {
              if (alive) timer = setTimeout(load, REFRESH_MS);
            });
        };
        load();
        return () => {
          alive = false;
          if (timer) clearTimeout(timer);
        };
      }, []);

      if (!selection) return null;
      const modelId = String(selection.model || "");
      const accountId = modelId.split("/")[0];
      if (!accountId) return null;
      // 网关的模型 id 一律是 `<账号 id>/<上游模型 id>`，**一定含 `/`**；DSH 自己的
      // 模型（`deepseek-flash` 这类）不含。所以清单没到手时用「含不含 `/`」兜底，
      // 而不是无条件放行。
      //
      // 2026-11-11 踩到的：key 失效 → `/api/health` 一直 401 → `accounts` 永远是
      // null → 门禁放行 → 徽标拿 `deepseek-flash` 去请求 `/api/accounts/deepseek-flash/credits`
      // → 401 → 在**官方模型**上显示「离线」。用户以为网关挂了，其实是这个门禁漏了。
      if (!modelId.includes("/")) return null;
      if (accounts && accounts.indexOf(accountId) === -1) return null;
      return React.createElement(CreditsStrip, { modelId: selection.model, provider: selection.provider });
    }

    function apply(ctx) {
      probe("apply");
      try {
        ctx.inject(["modelDirectories"], (scope) => {
          try {
            scope.slots.inject("conversation.input.right", () => {
              probe("inject-callback");
              return scope.slots.register(
                {
                  name: "conversation.input.right",
                  id: "credit-bridge",
                  order: 20,
                  inject: (sessionId) => ({
                    directory: scope.modelDirectories.directoryFor(sessionId).store,
                  }),
                },
                CreditsGate,
              );
            });
            probe("inject-called");
          } catch (error) {
            probe("inject-error");
            console.error("cb-dsh: slot registration failed", error);
          }
        });
      } catch (error) {
        probe("apply-error");
        console.error("cb-dsh: modelDirectories injection failed", error);
      }

      // Sidebar row in the Plugins group plus the page it opens. Registered on
      // its own so a dead gateway cannot hide the entry — the page is where the
      // user points the plugin at a new gateway and saves the key.
      try {
        ctx.slots.inject("sidebar.panellist", () => {
          try {
            probe("panellist-inject-callback");
            return ctx.slots.register(
              {
                name: "sidebar.panellist",
                id: SETTINGS_PANEL_ID,
                order: 5,
                label: PANEL_TITLE,
              },
              SettingsPanelIcon,
            );
          } catch (error) {
            probe("panellist-register-error");
            throw error;
          }
        });
        ctx.slots.inject("main", () => {
          try {
            probe("main-inject-callback");
            return ctx.slots.register({ name: "main", key: SETTINGS_PANEL_ID }, SettingsPanel);
          } catch (error) {
            probe("main-register-error");
            throw error;
          }
        });
        probe("panel-inject-called");
      } catch (error) {
        probe("panel-inject-error");
        console.error("cb-dsh: sidebar panel registration failed", error);
      }
    }

    exports.name = "cb-dsh";
    exports.inject = ["slots"];
    exports.apply = apply;
    return module.exports;
  },
});
