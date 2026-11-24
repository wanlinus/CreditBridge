// 把网关的模型列表写进 DSH profile 的 `models:` 段。
//
// 为什么在插件里做：profile 在**笔记本本机**，网关在 `192.168.1.100` 的容器里，它看到的
// `~/.dsh/profiles/...` 是 `/home/node/...`，根本不存在。插件 host 半边就跑在 DSH
// 进程里，和 profile 同一台机器。
//
// 逻辑是从 `cb-gateway/tools/sync-profile-models.mjs` 搬过来的，行为保持一致：
//   - 只写网关知道的东西，**其余字段原样逐行保留**（`input` / `reasoningEfforts`
//     由这里重新生成，所以连它们的子行一起跳过，否则会重复输出非法 YAML）
//   - 按 id 合并，不是整段重写
//   - 改前备份，只碰 `models:` 段，不做 YAML 往返序列化（profile 是手写的，任何
//     序列化都会把引号、键顺序、注释重排）
//
// 搬过来的原因：那个脚本得在笔记本上手跑。现在「网关 /models 页勾选 → 插件自动同步」
// 才是主流程，脚本保留给「不想开 DSH、只想一次性写盘」的场合。

import fs from 'node:fs';

import { blockEnd, indentOf, isBlank, providerAbove } from './yaml-lines.js';

/**
 * 把 `models:` 段里一个条目的字段解析出来。
 *
 * `input:` / `reasoningEfforts:` 由这里重新生成，所以**连同子行一起跳过**——只跳父行
 * 的话，`- text`、`low: low` 会被当成「要保留的字段」再输出一遍，直接产出非法 YAML。
 *
 * `contextWindow` 也跳过：网关现在是唯一事实源，插件不再保留「用户手调过的值」。
 */
function parseEntries(lines, start, end, itemIndent) {
  const entries = [];
  let current = null;
  let skipDeeperThan = Infinity;
  const itemRe = new RegExp(`^\\s{${itemIndent}}- id:\\s*(\\S+)\\s*$`, 'u');
  for (let i = start; i < end; i += 1) {
    if (isBlank(lines[i])) continue;
    const indent = indentOf(lines[i]);
    if (indent > skipDeeperThan) continue;
    skipDeeperThan = Infinity;

    const idMatch = itemRe.exec(lines[i]);
    if (idMatch) {
      current = { id: idMatch[1], extra: [] };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    const field = /^\s+([\w$.-]+):/u.exec(lines[i]);
    const key = field ? field[1] : '';
    if (['name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts'].includes(key)) {
      skipDeeperThan = indent;
      continue;
    }
    current.extra.push(lines[i]);
  }
  return entries;
}

/** 网关 `/v1/models` 的一项 → 同步用的形状。 */
export function normalizeModel(model) {
  return {
    id: model.id,
    name: typeof model.name === 'string' && model.name ? model.name : model.id,
    contextWindow: Number.isFinite(model.context_length) ? model.context_length : null,
    maxTokens: Number.isFinite(model.max_output_tokens) ? model.max_output_tokens : null,
    reasoning: model.reasoning === true,
    // 档位表原样透传。**兜底在网关**（`shared/model-settings.ts` 的 `FALLBACK_EFFORTS`）：
    // 网关对每个能思考的模型都会报一份非空表，插件不再自己补一套——两套兜底意味着
    // 「网关报的和 profile 里写的不是同一个东西」，而那种偏差不会报错。
    reasoningEfforts:
      Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length > 0
        ? model.reasoningEfforts
        : null,
    input: Array.isArray(model.input) && model.input.length > 0 ? model.input : null,
  };
}

/**
 * 聚合成一个 provider 时用：找 baseURL 的**路径正好是 `/v1`** 的那一段。
 *
 * 不能用 `endsWith('/v1')`：`http://host:7801/workbuddy/v1` 也以 `/v1` 结尾，
 * 会把聚合模型写进通道段里，两边的模型列表互相覆盖。
 */
export function applyAggregateModels(lines, models) {
  const at = lines.findIndex((line) => {
    const match = /^\s*baseURL:\s*(\S+)\s*$/u.exec(line);
    if (!match) return false;
    try {
      return new URL(match[1]).pathname === '/v1';
    } catch {
      return false;
    }
  });
  if (at < 0) return { lines, found: false, changed: false };
  return applyModelsAt(lines, at, models);
}

/** `applyAggregateModels` 的改写逻辑（`at` 已定位到 baseURL 行）。 */
function applyModelsAt(lines, at, models) {
  const provider = providerAbove(lines, at, indentOf(lines[at]));
  if (!provider) return { lines, found: false, changed: false };
  const end = blockEnd(lines, provider.start + 1, provider.indent);

  // 定位现有 models: 段（连同它的子行范围），并把已有条目的额外字段捞出来。
  // `[]` 也要认：通道被关掉时写的就是行内的 `models: []`，认不出来就会每次都
  // 认为「profile 里没有 models 段」，于是每 15 秒重写一次、把段落到 provider 末尾。
  let modelsAt = -1;
  let modelsIndent = 0;
  for (let i = provider.start + 1; i < end; i += 1) {
    const match = /^(\s*)models:\s*(?:\[\s*\])?\s*$/u.exec(lines[i]);
    if (match) {
      modelsAt = i;
      modelsIndent = match[1].length;
      break;
    }
  }

  const fieldIndent = indentOf(lines[at]);
  const itemIndent = fieldIndent + 2;
  const keyIndent = fieldIndent + 4;
  const pad = (n) => ' '.repeat(n);

  let preserved = [];
  let insertAt = modelsAt >= 0 ? modelsAt : end;
  let rest = lines;
  if (modelsAt >= 0) {
    const modelsEnd = blockEnd(lines, modelsAt + 1, modelsIndent);
    preserved = parseEntries(lines, modelsAt + 1, modelsEnd, itemIndent);
    rest = [...lines.slice(0, modelsAt), ...lines.slice(modelsEnd)];
    insertAt = modelsAt;
  }
  const byId = new Map(preserved.map((entry) => [entry.id, entry]));

  // 空数组要显式写成 `models: []`：只留一个光秃秃的 `models:` 是 YAML 的 null，
  // DSH 读到 null 究竟算「没配」还是「解析失败」说不清——通道关掉时写的就是这个
  // 空列表，不能赌。
  const block = models.length === 0 ? [`${pad(fieldIndent)}models: []`] : [`${pad(fieldIndent)}models:`];
  for (const model of models) {
    block.push(`${pad(itemIndent)}- id: ${model.id}`);
    block.push(`${pad(keyIndent)}name: ${JSON.stringify(model.name)}`);

    // `contextWindow` **照抄网关**，不做任何合并。
    //
    // 早先这里是 `min(profile 里的值, 网关值)`：那个时候 ⚙ 下拉能改 profile 里的数，
    // 同步必须尊重它，否则「改了 20 秒就被改回去」（2026-11-10 实测）。现在 ⚙ 和它的
    // 设置入口都没了，网关是唯一事实源——再保留那种合并，只会让「网关显示 400K、
    // profile 里却是别的数」这种偏差活下来，而且不报错。
    if (model.contextWindow !== null) block.push(`${pad(keyIndent)}contextWindow: ${model.contextWindow}`);

    if (model.maxTokens !== null) block.push(`${pad(keyIndent)}maxTokens: ${model.maxTokens}`);

    // input：网关报了就用网关的；没报（比如 Qoder 的 CLI 目录）就不写这一项。
    if (model.input) {
      block.push(`${pad(keyIndent)}input:`);
      for (const modality of model.input) block.push(`${pad(keyIndent + 2)}- ${modality}`);
    }

    // reasoningEfforts：**照抄网关报的档位表**。
    //
    // 网关已经做了两件事，插件不再重复：① 上游没报档位时用 `FALLBACK_EFFORTS` 兜底；
    // ② 把上游的 `none` 归一成 DSH 的 `off`。所以这里只负责**格式转换**——
    // DSH 的 profile 要的是 `{档位: 上游线上的值}` 的字典，不是数组。
    if (model.reasoning) {
      const efforts = Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length > 0
        ? model.reasoningEfforts
        : null;
      if (efforts) {
        block.push(`${pad(keyIndent)}reasoningEfforts:`);
        for (const level of efforts) {
          // `off` 的线上值写 `null`（DSH 的写法是 `off: null`，pi-ai 读到「支持，但什么
          // 都不发」）；其余档位键和值同名（`low: low`），原样搬。
          if (level === 'off') {
            block.push(`${pad(keyIndent + 2)}off: null`);
          } else {
            block.push(`${pad(keyIndent + 2)}${level}: ${level}`);
          }
        }
      }
    }

    const old = byId.get(model.id);
    if (old) for (const line of old.extra) block.push(line);
  }

  const next = [...rest.slice(0, insertAt), ...block, ...rest.slice(insertAt)];
  return { lines: next, found: true, changed: next.join('\n') !== lines.join('\n') };
}

/**
 * 拉一次网关的模型列表，写进 profile 里 baseURL 路径正好是 `/v1` 的那个 provider
 * 的 `models:` 段。
 *
 * **两种「0 个模型」必须分开**，只看 `/api/models` 的长度分不出来：
 *
 *   - **所有通道都被关掉了**（`/api/health` 里每个 `channels[..].listed` 都是 `false`）：
 *     这是用户的明确意图，写空的 `models: []`，让 DSH 里那些模型真的消失。
 *   - **取不到**（没登录、key 没权限、网关抖动）：**跳过、不动 profile**。一次掉线就
 *     把已有模型清空，DSH 里会凭空少一堆东西，而且看起来像同步器坏了。
 *
 * 所以 0 个模型时要多问一次 `/api/health` 拿 `listed`——网关侧把它单独暴露出来，
 * 正是为了让同步方分得清这两件事（见 `cb-gateway/API.md` 的 `channels[id].listed`）。
 */
export async function syncProfileModels(options) {
  const { profilePath, base, auth, fetchImpl = fetch, timeoutMs = 20000, log = () => {} } = options;
  const headers = { Accept: 'application/json' };
  if (auth) headers.Authorization = auth;

  // **只有一个入口**：`/api/models`。它和 `/v1/models` 逐字节相同（网关侧共用同一个
  // 函数），走 `/api` 是为了让「哪条是协议、哪条是网关私有」分得清。
  //
  // v1 那套「按通道分别拉 `<prefix>/v1/models` + 聚合段」已经删了：v2 的通道前缀
  // 路由本身就不存在，而且模型 id 里已经带了账号（`wb-1/hy4free`），不需要按通道拆。
  const response = await fetchImpl(`${base}/api/models`, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`/api/models HTTP ${response.status}`);
  const doc = await response.json();
  const models = (Array.isArray(doc.data) ? doc.data : [])
    .filter((model) => model && typeof model.id === 'string' && model.id)
    .map(normalizeModel);

  if (models.length === 0) {
    // 0 个模型：先确认「是不是用户把通道全关了」。问不到 `/api/health` 就当「取不到」，
    // 宁可留下旧列表，也不要在一次网络抖动后把 DSH 里的模型清空。
    let allChannelsOff = false;
    try {
      const healthResponse = await fetchImpl(`${base}/api/health`, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (healthResponse.ok) {
        const health = await healthResponse.json();
        const channels = health && health.channels && typeof health.channels === 'object' ? health.channels : null;
        const entries = channels ? Object.values(channels) : [];
        allChannelsOff = entries.length > 0 && entries.every((item) => item && item.listed === false);
      }
    } catch {
      allChannelsOff = false;
    }
    if (!allChannelsOff) {
      log('模型同步：网关返回 0 个模型（账号没登录 / key 没权限？），跳过');
      return { models: 0, wrote: false, backup: null, reason: 'empty' };
    }
    log('模型同步：所有通道都关掉了，写空 models 段');
  }

  const lines = fs.readFileSync(profilePath, 'utf8').split(/\r?\n/u);
  const applied = applyAggregateModels(lines, models);
  if (!applied.found) {
    log("模型同步：profile 里没有 baseURL 路径为 /v1 的 provider，跳过");
    return { models: models.length, wrote: false, backup: null, reason: 'no-provider' };
  }
  if (!applied.changed) {
    return { models: models.length, wrote: false, backup: null, reason: 'unchanged' };
  }

  // 写之前留备份：profile 是 DSH 的全部配置，写坏了 DSH 起不来。
  const backup = `${profilePath}.bak-model-sync-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
  fs.copyFileSync(profilePath, backup);
  fs.writeFileSync(profilePath, applied.lines.join('\n'), 'utf8');
  log(`模型同步：写入 ${models.length} 个模型，备份 ${backup}`);
  return { models: models.length, wrote: true, backup, reason: 'written' };
}
