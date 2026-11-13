window.__ModuleLoader__.load({
  id: "cb-dsh",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");

    let GATEWAY = "http://127.0.0.1:7801";

    const CONTROL_PREFIX = "/__cb-dsh";
    const CONTROL_HOST = (function () {
      try {
        const host = typeof location !== "undefined" ? String(location.hostname || "") : "";
        if (host === "") return "127.0.0.1";
        if (host === "localhost") return host;
        if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return host;
        if (/^\[[0-9a-f:.]+\]$/i.test(host)) return host;
        return "127.0.0.1";
      } catch {
        return "127.0.0.1";
      }
    })();
    const CONTROL_PORTS = [7802, 7803, 7804, 7805, 7806, 7807, 7808, 7809, 7810, 7811];
    let CONTROL = "http://" + CONTROL_HOST + ":7802";

    function isControlUrl(url) {
      const value = String(url);
      if (value.startsWith(CONTROL)) return true;
      const escapedHost = CONTROL_HOST.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const withControlPort = new RegExp("^http://" + escapedHost + ":(?:" + CONTROL_PORTS.join("|") + ")(?:[/?#]|$)");
      if (withControlPort.test(value)) return true;
      try {
        return value.startsWith(location.origin + CONTROL_PREFIX);
      } catch {
        return false;
      }
    }

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
      try {
        const diag = JSON.stringify({
          origin: typeof location !== "undefined" ? location.origin : null,
          hostname: typeof location !== "undefined" ? location.hostname : null,
          protocol: typeof location !== "undefined" ? location.protocol : null,
          CONTROL_HOST: CONTROL_HOST,
          tried: tried,
        });
        fetch(CONTROL + "/diag", { method: "POST", cache: "no-store", body: diag }).catch(() => {});
        if (CONTROL !== "http://127.0.0.1:7802") {
          fetch("http://127.0.0.1:7802/diag", { method: "POST", cache: "no-store", body: diag }).catch(() => {});
        }
      } catch {
      }
      return false;
    }

    const REFRESH_MS = 60000;

    function applyGatewayBase(raw) {
      if (typeof raw !== "string") return false;
      const value = raw.trim().replace(/\/+$/, "");
      if (!/^https?:\/\/[^\s/]+/i.test(value)) return false;
      const changed = GATEWAY !== value;
      GATEWAY = value;
      return changed;
    }

    let API_TOKEN = "";

    let CONFIGURED = null;

    function gwFetch(url, init) {
      const options = Object.assign({}, init);
      if (!isControlUrl(url)) {
        options.headers = Object.assign({}, init && init.headers, {
          Authorization: "Bearer " + API_TOKEN,
        });
      }
      return fetch(url, options);
    }

    function loadGatewayBase() {
      return fetch(CONTROL + "/config", { cache: "no-store" })
        .then((response) => response.json())
        .then((doc) => {
          if (!doc || !doc.ok) return;
          const baseChanged = applyGatewayBase(doc.gatewayBase);
          const tokenChanged = typeof doc.apiToken === "string" ? doc.apiToken !== API_TOKEN : false;
          if (typeof doc.apiToken === "string") API_TOKEN = doc.apiToken;
          if (typeof doc.configured === "boolean") CONFIGURED = doc.configured;
          if (baseChanged || tokenChanged) {
            try {
              window.dispatchEvent(new CustomEvent("cb-dsh-config-changed"));
            } catch {
            }
          }
        })
        .catch(() => {});
    }
    discoverControl().finally(() => {
      loadGatewayBase();
    });

    function panelUrlFor(accountId) {
      if (!accountId) return GATEWAY + "/accounts";
      return GATEWAY + "/accounts/" + encodeURIComponent(accountId);
    }

    function probe(stage) {
      try {
        gwFetch(GATEWAY + "/api/plugin-probe?stage=" + encodeURIComponent(stage), { cache: "no-store" }).catch(() => {});
      } catch {
      }
    }
    probe("factory");

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

    function fmtSize(n) {
      if (typeof n !== "number" || !isFinite(n)) return "—";
      if (n >= 1000000) {
        const millions = n / 1000000;
        return (Number.isInteger(millions) ? millions : millions.toFixed(1)) + "M";
      }
      if (n >= 1000) return Math.round(n / 1000) + "K";
      return String(n);
    }

    function ContextPicker({ modelId }) {
      const [open, setOpen] = React.useState(false);
      const [position, setPosition] = React.useState(null);
      const [info, setInfo] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [note, setNote] = React.useState("");
      const anchor = React.useRef(null);

      const load = React.useCallback(async () => {
        try {
          const mineDoc = await fetch(CONTROL + "/model-config?ids=" + encodeURIComponent(modelId), {
            cache: "no-store",
          }).then((response) => response.json());
          let live = null;
          try {
            const liveDoc = await gwFetch(GATEWAY + "/api/model-config?ids=" + encodeURIComponent(modelId), {
              cache: "no-store",
            }).then((response) => response.json());
            live = (liveDoc && liveDoc.upstream ? liveDoc.upstream : {})[modelId] || null;
          } catch {
            live = null;
          }
          const mine = ((mineDoc && mineDoc.models) || []).filter((m) => m.id === modelId)[0];
          setInfo({
            current: mine ? mine.contextWindow : null,
            max: live && typeof live.contextWindow === "number" ? live.contextWindow : null,
            options: live && live.lengths && Array.isArray(live.lengths.options) ? live.lengths.options : null,
            fallback: live && live.lengths && typeof live.lengths.default === "number" ? live.lengths.default : null,
          });
        } catch {
          setInfo(null);
        }
      }, [modelId]);

      React.useEffect(() => {
        if (open) load();
      }, [open, load]);

      React.useEffect(() => {
        if (!open) return undefined;
        const onDown = (event) => {
          if (anchor.current && !anchor.current.contains(event.target)) setOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        return () => document.removeEventListener("mousedown", onDown);
      }, [open]);

      const toggle = React.useCallback(() => {
        if (open) {
          setOpen(false);
          return;
        }
        const rect = anchor.current.getBoundingClientRect();
        const width = 232;
        const estHeight = 200;
        let left = rect.right - width;
        if (left < 8) left = 8;
        if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
        const roomAbove = rect.top;
        if (roomAbove >= estHeight + 8) {
          setPosition({ left, bottom: window.innerHeight - rect.top + 6, top: void 0 });
        } else {
          setPosition({ left, top: rect.bottom + 6, bottom: void 0 });
        }
        setNote("");
        setOpen(true);
      }, [open]);

      const apply = React.useCallback(
        async (value) => {
          setBusy(true);
          setNote("");
          try {
            const response = await fetch(CONTROL + "/model-config", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ updates: [{ id: modelId, contextWindow: value }] }),
            });
            const doc = await response.json();
            if (!response.ok || !doc.ok) throw new Error(doc.error || "HTTP " + response.status);
            setInfo((prev) => Object.assign({}, prev, { current: value }));
            setNote("已写入，重启 DSH 生效");
          } catch (error) {
            setNote("失败：" + String(error && error.message ? error.message : error).slice(0, 70));
          } finally {
            setBusy(false);
          }
        },
        [modelId],
      );

      const options = [];
      const hasTiers = !!(info && Array.isArray(info.options) && info.options.length > 0);
      if (hasTiers) {
        for (const value of info.options) options.push({ value, label: fmtSize(value) });
      } else if (info && typeof info.max === "number") {
        options.push({ value: info.max, label: fmtSize(info.max), fixed: true });
      } else if (info && typeof info.current === "number") {
        options.push({ value: info.current, label: fmtSize(info.current), fixed: true });
      }
      const overCap =
        info && typeof info.max === "number" && typeof info.current === "number" && info.current > info.max;
      const listed = options.some((option) => option.value === (info && info.current));
      if (hasTiers && info && typeof info.current === "number" && !listed) {
        options.unshift({ value: info.current, label: fmtSize(info.current), over: overCap, stale: !overCap });
      }

      const itemStyle = (active) => ({
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        width: "100%",
        padding: "7px 10px",
        border: "none",
        borderRadius: "6px",
        background: active ? "var(--dsh-color-fill-secondary, rgba(0,0,0,0.05))" : "transparent",
        color: "inherit",
        font: "inherit",
        fontSize: "12px",
        textAlign: "left",
        cursor: busy ? "default" : "pointer",
        opacity: busy ? 0.6 : 1,
      });

      return React.createElement(
        "span",
        { ref: anchor, style: { position: "relative", display: "inline-flex" } },
        React.createElement(
          "button",
          {
            type: "button",
            title:
              "上下文窗口（当前 " +
              fmtSize(info && info.current) +
              "）：调小会更早压缩长对话，省积分但丢细节",
            onClick: toggle,
            style: Object.assign({}, chipStyle, {
              padding: "0 6px",
              background: "transparent",
              color: open ? "var(--dsh-color-accent, #2f7d5c)" : "var(--dsh-color-text-tertiary, #999)",
              cursor: "pointer",
            }),
          },
          "⚙",
        ),
        open && position
          ? React.createElement(
              "div",
              {
                style: {
                  position: "fixed",
                  left: position.left + "px",
                  bottom: position.bottom + "px",
                  width: "232px",
                  padding: "6px",
                  borderRadius: "10px",
                  border: "1px solid var(--dsh-border-color, rgba(0,0,0,0.12))",
                  background: "var(--dsh-color-bg-elevated, #fff)",
                  boxShadow: "0 8px 28px rgba(0,0,0,0.18)",
                  zIndex: 2147483000,
                },
              },
              React.createElement(
                "div",
                {
                  style: {
                    padding: "4px 10px 7px",
                    fontSize: "11px",
                    color: "var(--dsh-color-text-tertiary, #999)",
                  },
                },
                "上下文窗口" + (info && info.max ? " · 上限 " + fmtSize(info.max) : ""),
              ),
              options.map((option) => {
                const active = info && info.current === option.value;
                const locked = option.fixed === true;
                const tint = option.over ? "#c0392b" : option.stale ? "#b7791f" : null;
                const tag = option.over ? "超出上限" : option.stale ? "不在可选档位" : locked ? "固定" : "";
                return React.createElement(
                  "button",
                  {
                    key: option.value,
                    type: "button",
                    disabled: busy || locked,
                    onClick: () => apply(option.value),
                    style: Object.assign(itemStyle(active), tint ? { color: tint } : null, locked
                      ? { cursor: "default", opacity: 1 }
                      : null),
                  },
                  React.createElement("span", null, option.label),
                  React.createElement(
                    "span",
                    { style: { fontSize: "11px", color: tint || "var(--dsh-color-text-tertiary, #999)" } },
                    locked || option.over || option.stale ? tag : active ? "✓" : tag,
                  ),
                );
              }),
              note
                ? React.createElement(
                    "div",
                    {
                      style: {
                        padding: "6px 10px 2px",
                        fontSize: "11px",
                        color: note.indexOf("失败") === 0 ? "#c0392b" : "var(--dsh-color-accent, #2f7d5c)",
                      },
                    },
                    note,
                  )
                : null,
            )
          : null,
      );
    }

    function CreditsStrip(props) {
      const modelId = props && props.modelId ? props.modelId : null;
      const provider = (props && props.provider) || "";
      const accountId = String(modelId || "").split("/")[0] || "";
      const [state, setState] = React.useState({ badge: null });
      const [icons, setIcons] = React.useState(null);
      const [powerState, setPowerState] = React.useState("unknown");
      const [configuredState, setConfiguredState] = React.useState(CONFIGURED);

      const refresh = React.useCallback(async () => {
        setConfiguredState(CONFIGURED);
        if (CONFIGURED === false) {
          setPowerState("stopped");
          return;
        }
        try {
          if (!accountId) throw new Error("模型 id 里没有账号段");
          const response = await gwFetch(GATEWAY + "/api/accounts/" + encodeURIComponent(accountId) + "/badge", {
            cache: "no-store",
          });
          if (!response.ok) throw new Error("HTTP " + response.status);
          setState({ badge: await response.json() });
          setPowerState("running");
          probe("fetch-ok");
        } catch (error) {
          setPowerState("stopped");
          probe("fetch-error");
        }
      }, [accountId]);

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
        const onConfigChanged = () => refresh();
        try {
          window.addEventListener("cb-dsh-config-changed", onConfigChanged);
        } catch {
        }
        return () => {
          clearInterval(timer);
          try {
            window.removeEventListener("cb-dsh-config-changed", onConfigChanged);
          } catch {
          }
        };
      }, [refresh]);

      const unconfigured = configuredState === false;
      const online = !unconfigured && powerState !== "stopped";
      const linked = !unconfigured && powerState === "running";

      const badge = state.badge;
      const label = unconfigured ? "未配置" : !online ? "离线" : (badge && badge.amount) || "已连接";
      const today = !unconfigured && online && badge && badge.today ? badge.today : "";
      const displayName = (badge && badge.title) || provider;
      const iconEntry = badge && badge.channel && icons ? icons[badge.channel] : null;
      const panelUrl = panelUrlFor(accountId);

      return React.createElement(
        "span",
        { style: { display: "inline-flex", alignItems: "center", gap: "4px", marginRight: "4px" } },
        React.createElement(
          "a",
          {
            href: linked ? panelUrl : undefined,
            target: "_blank",
            rel: "noreferrer",
            style: Object.assign({}, chipStyle, linked ? null : { cursor: "default" }),
          },
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
        online && modelId ? React.createElement(ContextPicker, { modelId }) : null,
      );
    }

    const SETTINGS_PANEL_ID = "dsh-credits";

    const PANEL_TITLE = "积分桥";

    const channelIcons = { base: null, icons: null, pending: null };

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

    function SettingsPanel() {
      const [gatewayDraft, setGatewayDraft] = React.useState("");
      const [tokenDraft, setTokenDraft] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [note, setNote] = React.useState(null);
      const [syncState, setSyncState] = React.useState(null);
      const [configured, setConfigured] = React.useState(CONFIGURED);

      function announceConfigChanged() {
        try {
          window.dispatchEvent(new Event("cb-dsh-config-changed"));
        } catch {
        }
      }

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
          const nowConfigured = typeof doc.configured === "boolean" ? doc.configured : Boolean(value && token);
          CONFIGURED = nowConfigured;
          setConfigured(nowConfigured);
          announceConfigChanged();
          if (doc.sync) setSyncState(doc.sync);

          const providerAction = doc.provider && doc.provider.action === "created" ? "新建了 provider" : "更新了 provider";
          const ref = doc.credentialRef ? "，key 已存进 DSH 凭据库（" + doc.credentialRef + "）" : "";
          const saved = providerAction + ref + "。";

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

    function CreditsGate({ directory }) {
      const subscribe = React.useCallback((listener) => directory.subscribe(listener), [directory]);
      const getSnapshot = React.useCallback(() => directory.getSnapshot(), [directory]);
      const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
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
                return;
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
