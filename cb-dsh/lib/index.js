// 插件的 host 半边：给 client 挂 Loader 行、记住网关地址供面板读写。
//
// **不管网关启停。** 早先有 /start /stop 会在本机 spawn 一份网关，那只会和容器里那份
// 抢同一批凭据；启停归 docker compose。2026-11 连同 spawnGateway 一起删了。
//
// 控制服务默认 7802，只监听 127.0.0.1。`QB_DSH_CONTROL_PORT` 可覆盖——但 client 半边
// 只探测 7802…7811，挪出这个区间面板就连不上，仅用于排查。

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { syncProfileModels } from './profile-models.js';
import { blockEnd, indentOf, providerAbove } from './yaml-lines.js';
import { startEventStream } from './events-client.js';
import { closeAll, closeForward, openForward } from './tunnel.js';

export const name = 'cb-dsh';

/**
 * 控制服务的监听面和端口。
 *
 * 默认**只听环回**：能读写「网关地址 + API key」，不该在局域网里裸奔。
 *
 * 但面板也会在别的浏览器里打开（手机连 `192.168.1.10:3081` 的 nginx 入口），那时页面
 * 脚本里的 127.0.0.1 是手机自己。解决办法不是把控制服务暴露到局域网，而是让
 * **同源的 nginx 反代一个 `/__cb-dsh/` 前缀**过来（见 dsh-lan/sync-cookie.ps1），
 * 客户端优先用这个同源前缀（见 client.js 的 discoverControl）。
 *
 * 万一没有反代、又想让别的机器直连，可以显式设 `QB_DSH_CONTROL_HOST=0.0.0.0`，
 * 客户端会退化成「用页面主机名的 7802」。Host 守卫仍在（只认 IP 字面量/localhost）。
 *
 * 端口：同一台机器可能有多个 DSH 实例（桌面版 + 网页版），谁先起谁占 7802，后起的
 * 顺延 7803…（见 listenControl），客户端按顺序探测。
 */
const CONTROL_HOST = process.env.QB_DSH_CONTROL_HOST || '127.0.0.1';
const CONTROL_PORT = Number(process.env.QB_DSH_CONTROL_PORT || 7802);
/** 端口顺延上限：7802..7811。再占满就报错（那时该显式配 QB_DSH_CONTROL_PORT 了）。 */
const CONTROL_PORT_SPAN = 10;

// 网关地址存在 DSH 的 profile 之外：重建插件包、重装插件都不该把它冲掉。
//
// `QB_DSH_CONFIG_DIR` 只为一件事存在：**让测试写临时目录**。`/setup` 会落配置，
// 测试要是用真目录，跑一次就把用户的「网关地址 + key」覆盖成桩数据
// （2026-11-10 就发生过：端到端测试把真 config.json 改成了 `http://127.0.0.1:7810`
// + `sk-TESTKEY`，而 `QB_DSH_PROFILE` 只能护住 profile、护不住这个文件）。
const CONFIG_DIR = process.env.QB_DSH_CONFIG_DIR
  ? path.resolve(process.env.QB_DSH_CONFIG_DIR)
  : path.join(os.homedir(), '.dsh', 'cb-dsh');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const LOG_PATH = path.join(CONFIG_DIR, 'plugin-host.log');

// 没配过的时候指向本机，也就是「网关还在本机跑」的老用法。
// 部署到服务器之后由面板里的「保存」覆盖掉。
const DEFAULT_GATEWAY_BASE = (process.env.QB_DSH_GATEWAY || 'http://127.0.0.1:7801').trim();

function log(line) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* 只用于诊断，写不进去就算了 */
  }
}

/**
 * 归一化网关地址。
 *
 * 尾部斜杠必须去掉：调用方全是 `GATEWAY + "/health"` 这种拼接，留着会拼出
 * `//health`。只接受 http/https，避免有人填成 `localhost:7801`（没有协议时
 * fetch 会当成相对路径，报一个和地址无关的错）。
 *
 * 返回 null 表示不合法，由调用方决定回 400。
 */
function normalizeBase(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().replace(/\/+$/u, '');
  if (!/^https?:\/\/[^\s/]+/iu.test(value)) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    // 保留路径前缀（有人可能挂在反代的子路径下），只清掉查询串和末尾斜杠。
    return value;
  } catch {
    return null;
  }
}

function readConfig() {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    stored = {};
  }
  // 「存下来的地址」和「兜底地址」必须分开：只有前者才证明用户配过。
  const storedBase = normalizeBase(stored.gatewayBase) || '';
  const base = storedBase || normalizeBase(DEFAULT_GATEWAY_BASE) || 'http://127.0.0.1:7801';
  // 凭据只有一种：网关 `/keys` 页发的 API key。用户名密码在 v2 E 阶段就从网关删了
  // （Basic 认证），存着只会让人以为还能用。
  //
  // key 明文存盘：和 DSH profile 里的 apiKey、data/auth 里的上游令牌同一个级别，
  // 都是「能读到这个文件就能冒充你」。单机单用户的定位下接受，别把这份配置放进
  // 代码仓库或备份。
  const apiToken = typeof stored.apiToken === 'string' ? stored.apiToken.trim() : '';
  /**
   * 到底有没有配过。
   *
   * **必须两项都有**：只有地址没有 key 时，网关的每个接口都回 401；只有 key 没有
   * 地址时连不上。这两种「半配置」状态下硬去拉模型、连事件流，用户看到的是
   * 「一直在失败」而不是「你还没配完」。所以判据是 `storedBase && apiToken`——
   * 用 `storedBase` 而不是 `base`，否则「兜底的 127.0.0.1」会被当成用户配过。
   */
  const configured = Boolean(storedBase && apiToken);
  return { gatewayBase: base, apiToken, storedBase, configured };
}

function writeConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------- profile 模型编辑
//
// 上下文窗口的选择要改 DSH profile 里那个模型的 `contextWindow`。这件事**必须在
// 插件里做**，不能交给网关：网关已经跑在另一台机器（容器）上，它看到的
// `~/.dsh/profiles/...` 是 `/home/node/...`，根本不存在。2026-11 把网关容器化
// 之后，面板的上下文选择器直接失灵，原因就是这个。
//
// 这里只做「按 id 就地改一个数字」，不解析整份 YAML：profile 是手写的，任何
// 序列化往返都会把引号、键顺序、注释全部重排。

// **改哪个 profile 必须问运行时，不能写死。** 2026-11 之前这里硬编码 `desktop`：
// 桌面版跑着没问题，但同一个插件装进别的 profile（web / headless）后，面板改上下文
// 窗口、写 provider、同步模型全都写到 `desktop/cordis.patch.yml` 去了——用户在 web 版
// 里点保存，桌面版的配置被改，而 web 版自己纹丝不动，看起来像「保存没生效」。
//
// 正确的来源是 DSH 给的 `ctx.get('profileContext').patchPath`（当前 profile 的
// patch 文件绝对路径，见 dsh-app-boot 的 ProfileContext 类型）。它在 `apply()` 时
// 才拿得到，所以这里是「先解析、后使用」：模块级别缓存一次，取不到再退回老路径。
//
// `QB_DSH_PROFILE` 仍然只为一件事存在：**让测试指向临时文件**。改的是真 profile 的话，
// 跑一次测试就把用户的模型清单、凭据字段改掉了。它优先级最高。
let activeProfilePath = null;

/** 解析当前进程该改哪个 profile 的 patch 文件。 */
function resolveProfilePath(ctx) {
  if (process.env.QB_DSH_PROFILE) return path.resolve(process.env.QB_DSH_PROFILE);
  try {
    const profile = ctx && typeof ctx.get === 'function' ? ctx.get('profileContext') : null;
    if (profile && typeof profile.patchPath === 'string' && profile.patchPath !== '') {
      return profile.patchPath;
    }
  } catch {
    /* 没有 profileContext（非 dsh 启动的组合），落到下面的兜底 */
  }
  return path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
}

/** 当前生效的 profile patch 路径。`apply()` 之前退化成兜底值。 */
function profilePath() {
  return activeProfilePath || resolveProfilePath(null);
}

/** 把 profile 的每一行读出来。文件不存在时报错给调用方。 */
function readProfileLines() {
  return fs.readFileSync(profilePath(), 'utf8').split(/\r?\n/);
}
// ---------------------------------------------------------------- 写 provider（一键配置）

/**
 * 把「网关地址 + key」写成 profile 里的一个 provider。
 *
 * 为什么需要：用户的心智是「填地址、填 key、点保存，DSH 就配好了」。而 provider
 * （`baseURL` / `apiKey` / `models`）是 DSH profile 里的配置，网关改不了——它在容器
 * 里，看不到这台机器的 profile。所以这一段必须由 host 半边写。
 *
 * 三种情况：
 *   - profile 里已有 `baseURL` 路径正好是 `/v1` 的 provider → 只改 apiKey / baseURL，
 *     models 段交给模型同步去写
 *   - 没有 → 在 `llm-pi-ai` 的 `providers:` 下新建一个（`id: qb`）
 *   - 连 `llm-pi-ai` 插件条目都没有 → 报错让用户先装插件，别偷偷造一个不完整的
 *     顶层条目（那种半成品会让 DSH 起不来）
 *
 * 返回 `{ ok: true, action, providerId, backup }` 或 `{ ok: false, error }`。
 */
/**
 * 凭据引用的默认名字。
 *
 * profile 里只放**引用**（`apiKeyEnv: <名字>`），真值进 DSH 的凭据库
 * （`~/.dsh/.credentials.yaml` 的 `refs`）。这是 DSH 唯一的认证通路：
 * `llm-pi-ai` 的 provider schema 里**没有 `apiKey` 字段**，`resolveApiKey()`
 * 只读 `profile.apiKeyEnv`。往 profile 里写明文 `apiKey` 是个死字段——
 * 既不报错也不生效，典型静默失败（2026-11-10 之前就是这么写的）。
 *
 * 现有的 provider 已经有 `apiKeyEnv` 时**沿用它**（比如用户的 `JF_API_KEY`），
 * 只把那一条引用的值换掉，profile 一个字都不用改。
 */
const DEFAULT_CREDENTIAL_REF = 'CB_GATEWAY_API_KEY';

/** 凭据库要求的名字形状：POSIX 标识符。不合法就退回默认名。 */
const CREDENTIAL_REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** 目标 provider 的定位结果。`ref` 是它现在用的凭据引用（没有就是 null）。 */
export function inspectProvider() {
  let lines;
  try {
    lines = readProfileLines();
  } catch (error) {
    return { ok: false, error: '读不到 DSH profile：' + error.message };
  }
  // 判据是「baseURL 的路径正好是 /v1」。不能用 endsWith('/v1')：
  // http://host:7801/workbuddy/v1 也满足，那是旧版按通道拆的条目。
  const baseAt = lines.findIndex((line) => {
    const match = /^\s*baseURL:\s*(\S+)\s*$/u.exec(line);
    if (!match) return false;
    try {
      return new URL(match[1]).pathname === '/v1';
    } catch {
      return false;
    }
  });
  if (baseAt < 0) return { ok: true, found: false, ref: null, providerId: null };

  const provider = providerAbove(lines, baseAt, indentOf(lines[baseAt]));
  if (!provider) return { ok: true, found: false, ref: null, providerId: null };
  const end = blockEnd(lines, provider.start + 1, provider.indent);
  let ref = null;
  for (let i = provider.start + 1; i < end; i += 1) {
    const match = /^\s*apiKeyEnv:\s*(\S+)\s*$/u.exec(lines[i]);
    if (match && CREDENTIAL_REF_RE.test(match[1])) {
      ref = match[1];
      break;
    }
  }
  return { ok: true, found: true, ref, providerId: provider.key };
}

/**
 * 把网关地址和凭据**引用**写进 profile 里那个 provider。
 *
 * 只做两件事：改 `baseURL`，确保 `apiKeyEnv` 指向 `credentialRef`；顺手把残留的
 * 明文 `apiKey` 行删掉（它从来没生效过，留着只会泄漏 key 并让人误会）。
 *
 * **不写 key 本身**——key 由调用方先存进凭据库（见 `/setup`）。顺序不能反：
 * 先写 `apiKeyEnv` 再存凭据的话，中途失败会留下「引用了不存在的凭据」，
 * DSH 每次请求都报 MISSING_CREDENTIAL。
 *
 * 导出是为了让 `test/write-provider.mjs` 跑**真代码**。早先那个测试只抽函数体、
 * 自己补桩，结果把 `providerAbove` / `blockEnd` 两个没定义的引用一起补上了——
 * 测试全绿，点保存必炸 `providerAbove is not defined`。
 */
export function writeProvider(config) {
  const base = normalizeBase(config.gatewayBase);
  if (!base) return { ok: false, error: '网关地址不合法' };
  const ref = typeof config.credentialRef === 'string' ? config.credentialRef.trim() : '';
  if (!ref) return { ok: false, error: '缺凭据引用名' };
  if (!CREDENTIAL_REF_RE.test(ref)) return { ok: false, error: `凭据引用名不合法：${ref}` };

  let lines;
  try {
    lines = readProfileLines();
  } catch (error) {
    return { ok: false, error: '读不到 DSH profile：' + error.message };
  }

  // 判据是「baseURL 的路径正好是 /v1」。不能用 endsWith('/v1')：
  // http://host:7801/workbuddy/v1 也满足，那是旧版按通道拆的条目。
  const baseAt = lines.findIndex((line) => {
    const match = /^\s*baseURL:\s*(\S+)\s*$/u.exec(line);
    if (!match) return false;
    try {
      return new URL(match[1]).pathname === '/v1';
    } catch {
      return false;
    }
  });

  let action;
  let providerId;
  let droppedApiKey = false;

  if (baseAt >= 0) {
    lines[baseAt] = lines[baseAt].replace(/(baseURL:\s*)\S+/u, '$1' + base + '/v1');
    const provider = providerAbove(lines, baseAt, indentOf(lines[baseAt]));
    const providerEnd = provider ? blockEnd(lines, provider.start + 1, provider.indent) : lines.length;
    const providerStart = provider ? provider.start : 0;

    let envAt = -1;
    let apiKeyAt = -1;
    for (let i = providerStart + 1; i < providerEnd; i += 1) {
      if (envAt < 0 && /^\s*apiKeyEnv:\s*/u.test(lines[i])) envAt = i;
      if (apiKeyAt < 0 && /^\s*apiKey:\s*.*$/u.test(lines[i])) apiKeyAt = i;
    }
    const fieldIndent = ' '.repeat(indentOf(lines[baseAt]));
    if (envAt >= 0) {
      lines[envAt] = lines[envAt].replace(/(apiKeyEnv:\s*).*$/u, '$1' + ref);
    } else {
      lines.splice(baseAt + 1, 0, fieldIndent + 'apiKeyEnv: ' + ref);
      if (apiKeyAt >= 0 && apiKeyAt > baseAt) apiKeyAt += 1;
    }
    // 明文 apiKey 是死字段（DSH 不读），删掉：它既泄漏 key，又让人以为在生效。
    if (apiKeyAt >= 0) {
      lines.splice(apiKeyAt, 1);
      droppedApiKey = true;
    }
    action = 'updated';
    providerId = provider ? provider.key : '?';
  } else {
    // 没有 baseURL 指向 `/v1` 的 provider → **自己补齐结构，不要求用户手工加**。
    //
    // DSH 在「一个 provider 都没有」时写的是 `providers: {}`（行内空映射）；更早或
    // 手改过的 profile 还可能整个 `providers:` 键都没有、甚至连 `config:` 都没有。
    // 这三种形态都要能落成同一个结果——否则用户看到的是「保存失败，先手工加一个
    // provider」，而这件事本来就是插件该做的（2026-11-10 就是这么卡住的）。
    const pluginAt = lines.findIndex((line) => /^- id:\s*llm-pi-ai\s*$/u.test(line));
    if (pluginAt < 0) {
      return {
        ok: false,
        error: 'profile 里没有 llm-pi-ai 条目（DSH 没启用 OpenAI 兼容 provider？），没法写 provider',
      };
    }

    // 条目范围：到下一个顶层 `- id:` 或文件尾。
    let entryEnd = lines.length;
    for (let i = pluginAt + 1; i < lines.length; i += 1) {
      if (/^- id:/u.test(lines[i])) {
        entryEnd = i;
        break;
      }
    }

    const pad = (n) => ' '.repeat(n);
    const entryIndent = indentOf(lines[pluginAt]);
    const keyIndent = entryIndent + 2; // `  name:` / `  config:` 那一级
    const providersKeyIndent = keyIndent + 2; // `    providers:`
    const providerIndent = providersKeyIndent + 2; // `      qb:`
    const fieldIndent = providerIndent + 2; // `        displayName:`

    const providerLines = [
      pad(providerIndent) + 'qb:',
      pad(fieldIndent) + 'displayName: 积分桥',
      pad(fieldIndent) + 'api: openai-completions',
      pad(fieldIndent) + 'baseURL: ' + base + '/v1',
      pad(fieldIndent) + 'apiKeyEnv: ' + ref,
      pad(fieldIndent) + 'models: []',
    ];

    // 找 `providers:`，两种写法都认：块形式 `providers:` 和行内空映射 `providers: {}`。
    let providersAt = -1;
    let providersInlineEmpty = false;
    for (let i = pluginAt + 1; i < entryEnd; i += 1) {
      if (/^\s*providers:\s*$/u.test(lines[i])) {
        providersAt = i;
        break;
      }
      if (/^\s*providers:\s*\{\s*\}\s*$/u.test(lines[i])) {
        providersAt = i;
        providersInlineEmpty = true;
        break;
      }
    }

    if (providersAt >= 0 && providersInlineEmpty) {
      // `providers: {}` → 换成块形式再把 provider 塞进去。
      lines.splice(providersAt, 1, pad(providersKeyIndent) + 'providers:', ...providerLines);
    } else if (providersAt >= 0) {
      // 块形式：插到这个 providers 块的末尾（跳过子项，遇到同级或更浅就停）。
      const providersIndent = indentOf(lines[providersAt]);
      let insertAt = providersAt + 1;
      for (let i = providersAt + 1; i < entryEnd; i += 1) {
        if (lines[i].trim() === '') break;
        if (indentOf(lines[i]) <= providersIndent) break;
        insertAt = i + 1;
      }
      lines.splice(insertAt, 0, ...providerLines);
    } else {
      // 连 providers 键都没有：先找到 `config:`，没有就把 config 一起建出来。
      let configAt = -1;
      for (let i = pluginAt + 1; i < entryEnd; i += 1) {
        if (/^\s*config:\s*$/u.test(lines[i])) {
          configAt = i;
          break;
        }
      }
      if (configAt >= 0) {
        // 插到 config 块末尾（providers 是它的子项）。
        let insertAt = configAt + 1;
        for (let i = configAt + 1; i < entryEnd; i += 1) {
          if (lines[i].trim() === '') break;
          if (indentOf(lines[i]) <= keyIndent) break;
          insertAt = i + 1;
        }
        lines.splice(insertAt, 0, pad(providersKeyIndent) + 'providers:', ...providerLines);
      } else {
        // 连 config 都没有：在条目末尾补 `config:` + `providers:` + provider。
        lines.splice(entryEnd, 0, pad(keyIndent) + 'config:', pad(providersKeyIndent) + 'providers:', ...providerLines);
      }
    }

    action = 'created';
    providerId = 'qb';
  }

  const target = profilePath();
  const backup = target + '.bak-provider-' + new Date().toISOString().replace(/[:.]/gu, '-');
  try {
    fs.copyFileSync(target, backup);
    fs.writeFileSync(target, lines.join('\n'), 'utf8');
  } catch (error) {
    return { ok: false, error: '写 profile 失败：' + error.message };
  }
  log(
    '写 provider：' + action + ' ' + providerId + ' → ' + base + '/v1，凭据引用 ' + ref +
      (droppedApiKey ? '（删掉了明文 apiKey 行）' : '') +
      '（备份 ' + path.basename(backup) + '）',
  );
  return { ok: true, action, providerId, ref, droppedApiKey, backup: path.basename(backup) };
}

// ---------------------------------------------------------------- 模型清单自动同步
//
// 网关 `/models` 页勾选「哪些模型出现在 DSH」之后，DSH 并不会自己知道——它的模型
// 列表只读 profile 的 `models:` 段。早先靠人在笔记本上手跑
// `node tools/sync-profile-models.mjs ... --write`，忘了就永远不生效。
//
// 现在由 host 半边轮询：每 15 秒问一次网关 `/api/models`，跟 profile
// 里现有的 `models:` 段逐字节比，**不一样才写**（写前备份）。所以：
//   - 网关勾完开关，最多十几秒 DSH 列表就变；
//   - 上游目录增删模型也会被带进来；
//   - 没变化时不碰文件，不会每 15 秒生成一堆备份。

const MODEL_SYNC_INTERVAL_MS = 15 * 1000;
const MODEL_SYNC_START_DELAY_MS = 4 * 1000;

let modelSyncState = { at: null, ok: null, error: null, models: 0, wrote: false, backup: null, trigger: null };
let modelSyncTask = null;
let lastSyncError = '';

/**
 * 给网关的认证头。
 *
 * **只认 API key**（`Authorization: Bearer sk-…`）。网关的 Basic 认证在 v2 E 阶段删了：
 * 用户名密码只用于**人**登录网关网页，程序（DSH、脚本）一律用 `/keys` 页发的 key——
 * 两者生命周期不同，改密码不该让 DSH 掉线，吊销 key 也不该让人退出登录。
 *
 * 早先这里还支持 `Basic base64(用户名:密码)`，那是 v1 的做法。留着它只会让人觉得
 * 「填密码也能用」，然后一直 401 却不知道为什么。
 */
function gatewayAuthHeader(config) {
  return config.apiToken ? `Bearer ${config.apiToken}` : '';
}

/**
 * 跑一次同步。`trigger` 只进日志和 `/model-sync` 的返回值，区分轮询/启动/手动。
 *
 * 同一时刻只跑一次：并发调用（比如手动点在轮询正中间）直接**复用**那一次的结果，
 * 而不是回一个 `busy` 让调用方自己重试——手点一下却看到「忙」，比等两秒更让人困惑。
 *
 * 失败不抛：这是个后台轮询，抛出去只会变成未捕获的 rejection 把进程搞脏。
 */
function runModelSync(trigger) {
  if (modelSyncTask) return modelSyncTask;
  const task = (async () => {
    try {
      const config = readConfig();
      // 没配置就不发请求。这不是「失败」，是「还没开始用」——回一个明确的
      // configured:false，让面板显示「去配置」而不是一条网络错误。
      if (!config.configured) {
        const message = '还没配置网关地址和 API key';
        modelSyncState = { at: Date.now(), ok: false, configured: false, error: message, models: 0, wrote: false, backup: null, trigger };
        if (message !== lastSyncError) {
          log(`模型同步（${trigger}）跳过：${message}`);
          lastSyncError = message;
        }
        return { ok: false, configured: false, error: message };
      }
      const result = await syncProfileModels({
        profilePath: profilePath(),
        base: config.gatewayBase,
        auth: gatewayAuthHeader(config),
        log,
      });
      modelSyncState = { at: Date.now(), ok: true, configured: true, error: null, trigger, ...result };
      if (result.wrote) {
        log(`模型同步（${trigger}）：写入 ${result.models} 个模型（备份 ${result.backup ? path.basename(result.backup) : '—'}）`);
      }
      lastSyncError = '';
      return { ok: true, ...result };
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      modelSyncState = { at: Date.now(), ok: false, error: message, models: 0, wrote: false, backup: null, trigger };
      // 网关不可达时别每 15 秒刷一行同样的错
      if (message !== lastSyncError) {
        log(`模型同步（${trigger}）失败：${message}`);
        lastSyncError = message;
      }
      return { ok: false, error: message };
    }
  })();

  // **清理必须写在赋值之后，不能放进 async 体的 `finally`。**
  //
  // 体里若有一条不经过 await 就 return 的分支（「还没配置」就是），整个函数体会同步
  // 跑完，`finally` 在 `modelSyncTask = task` 这行执行**之前**就把变量清掉了；随后
  // 赋值又把那个已经完成的 promise 存进去，之后每次调用都直接返回它——同步永远停在
  // 「还没配置」，哪怕配置早就齐了（2026-11-10 就是这么坏的自测才发现）。
  modelSyncTask = task;
  const clear = () => {
    if (modelSyncTask === task) modelSyncTask = null;
  };
  task.then(clear, clear);
  return task;
}

/**
 * 挡 DNS rebinding，不校验 Origin。
 *
 * Origin 白名单在这里不成立：DSH 渲染进程报的 Origin 不受我们控制，
 * 实测既不是 `null` 也不是 `http://127.0.0.1:*`，按 Origin 拦会把面板自己的请求
 * 全挡成 403。真正要防的是「远程页面把自己的域名解析到 127.0.0.1」——那种请求的
 * `Host` 仍是攻击者的域名，所以查 Host 既挡住它，又放行任何本地调用方。
 *
 * **放行范围是「IP 字面量 + localhost」**，不是只有环回：面板可能在手机上打开，
 * 那时 Host 是 `192.168.1.10:7802`。域名一律拒绝——那正是 rebinding 的入口。
 */
function hostAllowed(host) {
  if (typeof host !== 'string' || host === '') return true;
  return /^(localhost|\[[0-9a-f:.]+\]|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/iu.test(host);
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 8 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

function createControlServer() {
  return http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1');
    try {
      if (!hostAllowed(req.headers.host)) {
        sendJson(res, 403, { ok: false, error: `host not allowed: ${req.headers.host}` });
        return;
      }

      if (url.pathname === '/diag' && req.method === 'POST') {
        // 面板侧自述诊断：把 location/CONTROL 探测过程写进 host 日志。
        // 为什么需要它：面板在浏览器里跑，`Failed to fetch` 时我们看不到它试了哪些
        // 地址、算出的 CONTROL 是什么。这些信息只能由面板自己上报。
        const raw = await readBody(req);
        log(`diag ${String(raw).slice(0, 800)}`);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (url.pathname === '/config' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, ...readConfig(), default: normalizeBase(DEFAULT_GATEWAY_BASE) });
        return;
      }

      if (url.pathname === '/config' && req.method === 'POST') {
        const raw = await readBody(req);
        let body = {};
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          sendJson(res, 400, { ok: false, error: '请求体不是 JSON' });
          return;
        }
        const current = readConfig();
        // 两项都是可选的：只改地址时不该把 token 清掉，反之亦然。
        const base = body && body.gatewayBase !== undefined ? normalizeBase(body.gatewayBase) : current.gatewayBase;
        if (!base) {
          sendJson(res, 400, { ok: false, error: '网关地址要写成 http://主机:端口' });
          return;
        }
        const apiToken = body && body.apiToken !== undefined ? String(body.apiToken || '').trim() : current.apiToken;
        writeConfig({ gatewayBase: base, apiToken });
        log(`config -> ${base}${apiToken ? '（有 key）' : '（没有 key）'}`);
        // 换网关/换 key 之后旧的事件流已经没意义了（它带着旧凭据连旧地址）。
        startEvents();
        sendJson(res, 200, { ok: true, gatewayBase: base, apiToken, configured: Boolean(base && apiToken) });
        return;
      }

      /**
       * 一键配置：存配置 → 把 key 存进 DSH 凭据库 → 写 profile 的 provider → 同步模型。
       *
       * 面板上「保存」按钮打的就是这条。用户的心智是「填完点保存，DSH 就配好了」。
       *
       * 顺序很重要：
       *   1. 先 `credentials.set(ref, key)` —— 凭据库是认证的唯一来源；
       *   2. 再写 profile 的 `apiKeyEnv: <ref>` —— 反过来会短暂留下「引用了不存在的
       *      凭据」，DSH 每次请求都报 MISSING_CREDENTIAL。
       *
       * 模型同步失败**不算保存失败**：地址和 key 已经落盘、profile 也改好了，只是
       * 拉模型这一步没通（key 错了、网关没起来）。回 200 带 `sync.ok:false`，让面板
       * 显示「已保存，但模型同步失败：…」，而不是让人以为白填了。
       */
      if (url.pathname === '/setup' && req.method === 'POST') {
        const raw = await readBody(req);
        let body = {};
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          sendJson(res, 400, { ok: false, error: '请求体不是 JSON' });
          return;
        }
        const base = body && body.gatewayBase !== undefined ? normalizeBase(body.gatewayBase) : readConfig().gatewayBase;
        if (!base) {
          sendJson(res, 400, { ok: false, error: '网关地址要写成 http://主机:端口' });
          return;
        }
        const apiToken = body && body.apiToken !== undefined ? String(body.apiToken || '').trim() : readConfig().apiToken;
        if (!apiToken) {
          sendJson(res, 400, { ok: false, error: '先填 API key（在网关 /keys 页创建）' });
          return;
        }

        // profile 里那个 provider 现在用的引用（没有就用默认名）。
        const target = inspectProvider();
        if (target.ok === false) {
          sendJson(res, 500, { ok: false, gatewayBase: base, error: target.error });
          return;
        }
        const ref = target.ref || DEFAULT_CREDENTIAL_REF;

        const credentials = getCredentials();
        if (!credentials) {
          sendJson(res, 500, {
            ok: false,
            gatewayBase: base,
            error:
              '这个 DSH 没有可用的 credentials 服务，key 没地方存。' +
              '先在 DSH 设置 → 模型服务里给这个 provider 填一次 key，再回来改地址',
          });
          return;
        }
        try {
          await credentials.set(ref, apiToken);
        } catch (error) {
          sendJson(res, 500, {
            ok: false,
            gatewayBase: base,
            error: `写不进凭据库（${ref}）：${error && error.message ? error.message : error}`,
          });
          return;
        }

        // 凭据到手之后才改 profile —— 顺序反了会留下悬空引用。
        const provider = writeProvider({ gatewayBase: base, credentialRef: ref });
        if (!provider.ok) {
          sendJson(res, 500, { ok: false, gatewayBase: base, error: provider.error });
          return;
        }

        writeConfig({ gatewayBase: base, apiToken });
        // 地址/凭据变了，事件流要换到新的那套（旧流还连着上一个网关）。
        startEvents();

        const sync = await runModelSync('setup');
        sendJson(res, 200, {
          ok: true,
          gatewayBase: base,
          configured: Boolean(base && apiToken),
          credentialRef: ref,
          provider,
          sync,
        });
        return;
      }

      if (url.pathname === '/model-sync' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, state: modelSyncState });
        return;
      }

      if (url.pathname === '/model-sync' && req.method === 'POST') {
        const result = await runModelSync('manual');
        sendJson(res, result.ok === false ? 500 : 200, { ok: result.ok !== false, ...result });
        return;
      }

      sendJson(res, 404, { ok: false, error: 'no route' });
    } catch (error) {
      log(`control error ${req.method} ${url.pathname}: ${error.message}`);
      sendJson(res, 500, { ok: false, error: error.message });
    }
  });
}

// 热重载时上一个 server 必须先关，否则端口被一个已经没人引用的模块实例占着。
const SERVER_KEY = Symbol.for('dsh.quota.bridge.controlServer');
// 事件流同理：重载后旧的那条还连着网关，不关就两条流一起收事件（转发会重复开）。
const EVENTS_KEY = Symbol.for('dsh.quota.bridge.eventStream');

/**
 * DSH 的 credentials 服务（`~/.dsh/.credentials.yaml` 的读写口）。
 *
 * 为什么不直接写那个 YAML 文件：它由 credentials-local 管，写盘走
 * 「文件锁 + 原子替换」，而且它挂了 chokidar 在监听。自己 `writeFileSync` 会
 * 和它的写入抢，最坏情况把 `records:`（登录态）整段冲掉。
 *
 * **两个坑都踩过**：
 *   1. `ctx.get('credentials')` 在 `apply()` 那一刻**拿不到**——服务还没 provide。
 *      表现是面板保存报「这个 DSH 没有可用的 credentials 服务」。
 *   2. 正确写法是 `ctx.inject(['credentials'], cb)`：cb 在服务就绪后才跑，
 *      DSH 自己的插件（`dsh-api-gateway`、`dsh-client-connection` 等）全是这么拿的。
 *
 * 所以这里两手准备：inject 的回调把服务存下来；真到用的时候还没存上，就再从
 * 宿主 ctx 现取一次（`getCredentials()`），避免依赖回调时序。
 */
let credentialsService = null;
let hostCtx = null;

function getCredentials() {
  if (credentialsService) return credentialsService;
  // 兜底：inject 的回调还没跑（或这个组合干脆没挂），就在调用点现问一次。
  // `/setup` 是用户点按钮才进来的，那时服务肯定已就绪。
  try {
    const live = hostCtx && typeof hostCtx.get === 'function' ? hostCtx.get('credentials') : null;
    if (live) credentialsService = live;
  } catch {
    /* 没有就是没有 */
  }
  return credentialsService;
}

function captureCredentials(ctx) {
  hostCtx = ctx || null;
  try {
    if (ctx && typeof ctx.inject === 'function') {
      ctx.inject(['credentials'], (scope) => {
        const found =
          (scope && typeof scope.get === 'function' ? scope.get('credentials') : null) ||
          (scope && scope.credentials) ||
          null;
        if (found) {
          credentialsService = found;
          log('credentials 服务已就绪（面板可以把 key 存进凭据库）');
        } else {
          log('inject 到 credentials 但取不到实例');
        }
      });
    }
  } catch (error) {
    log('inject credentials 失败：' + (error && error.message ? error.message : error));
  }
}

export function apply(ctx) {
  // 绝不让这个插件把 loader 的加载流程打断：这里抛异常看起来会像「DSH 起不来」，
  // 而实际只是一个额度徽标。
  try {
    applyInner(ctx);
  } catch (error) {
    log(`apply failed: ${error && error.stack ? error.stack : error}`);
  }
}

/**
 * 处理一个网关事件。
 *
 * 现在只有一种：`login`。Trae 的授权页只肯把浏览器跳回环回地址，而网关在服务器上，
 * 所以插件要在**点登录的瞬间**把 `127.0.0.1:<port>` 转到网关。`state: running` 开
 * 转发，其余状态（done/error/cancelled）关掉——留着只会占一个没人要的端口。
 *
 * 不是每个通道都需要转发：通道没声明 `loginLoopback()` 时事件里 `loopback` 是 null，
 * 直接忽略。
 */
function handleGatewayEvent(event) {
  if (!event || event.type !== 'login') return;
  const loopback = event.loopback;
  if (!loopback || !loopback.port) return;

  if (event.state === 'running') {
    const config = readConfig();
    let target;
    try {
      target = new URL(config.gatewayBase);
    } catch {
      log(`登录通道没法开：网关地址不合法（${config.gatewayBase}）`);
      return;
    }
    if (target.protocol !== 'http:') {
      // 回调是明文 HTTP，走 HTTPS 前置代理时纯 TCP 转发会握手失败。宁可说清楚，
      // 也不要让用户对着一个「登录没反应」发呆。
      log(`登录通道没法开：网关是 ${target.protocol}，而回调是明文 HTTP（纯 TCP 转发不支持）`);
      return;
    }
    openForward({ port: loopback.port, targetHost: target.hostname, targetPort: loopback.port }).then((result) => {
      if (result.ok) {
        log(`${event.channelId} 登录：已把 127.0.0.1:${loopback.port} 转到 ${target.hostname}:${loopback.port}`);
      } else {
        log(`${event.channelId} 登录：开回调通道失败 —— ${result.error}`);
      }
    });
    return;
  }

  if (closeForward(loopback.port)) {
    log(`${event.channelId} 登录结束（${event.state}）：回调通道已关闭`);
  }
}

/** 起事件流。配置变了（面板保存）要重建，所以句柄存在 globalThis 上跨重载可收。 */
function startEvents() {
  const previous = globalThis[EVENTS_KEY];
  if (previous && typeof previous.stop === 'function') {
    try {
      previous.stop();
      log('previous event stream stopped (reload)');
    } catch {
      /* 已经没了 */
    }
  }
  const config = readConfig();
  if (!config.configured) {
    // 没配好就不连：连上去只会被 401（没 key）或 connection refused（没地址）反复
    // 打，日志里每 5 秒一条重连失败，用户还以为插件坏了。
    log('还没配置网关地址和 API key，事件流不启动（登录通道不会自动开）');
    globalThis[EVENTS_KEY] = null;
    return null;
  }
  const stream = startEventStream({
    baseUrl: config.gatewayBase,
    apiToken: config.apiToken,
    onEvent: handleGatewayEvent,
    log,
  });
  globalThis[EVENTS_KEY] = stream;
  return stream;
}

/**
 * 绑定控制服务，端口被占就顺延。
 *
 * 为什么需要顺延：同一台机器上能同时跑多个 DSH（桌面版 + 网页版，或两个 web），
 * 每个进程都会加载一份这个插件。写死 7802 的话第二个实例的 `listen` 直接
 * `EADDRINUSE`，它的面板就永远连不上自己的 host 半边——而客户端探测会落到
 * 第一个实例上，读到「别人的」配置。顺延之后每个实例有自己的端口，客户端按
 * 顺序探到哪个就是自己的（先起的先占 7802）。
 */
function listenControl(server) {
  let port = CONTROL_PORT;
  const last = CONTROL_PORT + CONTROL_PORT_SPAN - 1;

  const attempt = () => {
    const onError = (error) => {
      if (error && error.code === 'EADDRINUSE' && port < last) {
        port += 1;
        attempt();
        return;
      }
      log(`control server 绑不上 ${CONTROL_HOST}:${port}：${error && error.message ? error.message : error}`);
    };
    server.once('error', onError);
    server.listen(port, CONTROL_HOST, () => {
      server.removeListener('error', onError);
      const shown = CONTROL_HOST === '0.0.0.0' ? '0.0.0.0（局域网可达）' : CONTROL_HOST;
      log(`control server listening on http://${shown}:${port}`);
    });
  };

  attempt();
}

function applyInner(ctx) {
  // **先定死这次要改哪个 profile**：后面所有读写（上下文窗口、provider、模型同步）
  // 都用它。取不到 profileContext 时退回老路径，并在日志里说明——否则「面板保存了
  // 但没生效」会变成一个查不出原因的现象。
  activeProfilePath = resolveProfilePath(ctx);
  log(
    `host-apply (control ${CONTROL_HOST}:${CONTROL_PORT}(起), gateway ${readConfig().gatewayBase}, profile ${activeProfilePath})`,
  );
  captureCredentials(ctx);

  const previous = globalThis[SERVER_KEY];
  if (previous && typeof previous.close === 'function') {
    try {
      previous.close();
      log('previous control server closed (reload)');
    } catch {
      /* 已经没了 */
    }
  }

  const server = createControlServer();
  server.on('error', (error) => log(`control server error: ${error.message}`));
  listenControl(server);
  globalThis[SERVER_KEY] = server;

  // 事件流：登录要开回调通道时网关会推过来，见 handleGatewayEvent。
  startEvents();

  // 模型清单轮询。启动后先等几秒（DSH 起来时还在读 profile），之后每 15 秒一次。
  // 定时器 unref：不能让它成为「DSH 退不掉」的理由。
  const syncTimer = setInterval(() => {
    runModelSync('poll');
  }, MODEL_SYNC_INTERVAL_MS);
  syncTimer.unref?.();
  const syncKickoff = setTimeout(() => {
    runModelSync('startup');
  }, MODEL_SYNC_START_DELAY_MS);
  syncKickoff.unref?.();

  if (ctx && typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      try {
        clearInterval(syncTimer);
        clearTimeout(syncKickoff);
        const stream = globalThis[EVENTS_KEY];
        if (stream && typeof stream.stop === 'function') stream.stop();
        globalThis[EVENTS_KEY] = null;
        closeAll();
        server.close();
        log('control server closed (dispose)');
      } catch {
        /* ignore */
      }
    });
  }
}
