// 打包时用：从本机 DSH profile 的 cordis.patch.yml 里抽出**网关那个 provider**的骨架，
// 写成 providers.json 放进分发包。
//
// ## v2 的形态
//
// profile 里只有一个网关 provider：`config.providers.<名字>`，靠 `baseURL` 的**路径
// 正好是 `/v1`** 认出来（v1 那套按通道拆的 `workbuddy` / `trae` / `qoder` 键已经不
// 存在了）。名字是用户起的（本机叫「积分桥」，键名 `qb`），所以**不能按名字找**。
//
// ## 为什么必须剥离，不能整块拷走
//
// 这个 provider 条目里带着三样**只属于打包这台机器**的东西，整块拷走会把它们一起发出去：
//
//   `apiKeyEnv`  —— 指向打包机的凭据引用名（收件人机器上没有这条引用）
//   `models:`    —— 打包机上的模型清单（收件人该由插件从**自己的**网关同步）
//   `baseURL`    —— 打包机的网关地址（收件人填自己的）
//
// 所以产出的是**骨架**：`displayName` 之类的展示字段保留，上面三样一律不带。
// 收件人装完后在「积分桥」面板填网关地址 + API key，插件会把这几项写对。
//
// ## 白名单
//
// 只抽「`baseURL` 路径正好 `/v1`」的那一个 provider；tokenhub / xf 这类要用户自己
// API key、或者纯个人偏好的条目**绝不进包**。别改成「全抽」。
//
// 用法：node extract-providers.mjs <cordis.patch.yml> <输出 providers.json>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/** 这些键是「这台机器的事实」，一律不随包走。 */
const LOCAL_ONLY_KEYS = ['apiKeyEnv', 'apiKey', 'baseURL', 'models', 'headers'];

/** 保留的展示字段（其余未知键也保留，见下）。 */
const KEEP_KEYS = ['displayName', 'name', 'label'];

function loadYaml(fromDir) {
  // js-yaml 是 DSH 自己的依赖，装在 profile 的 node_modules 里。从目标文件所在
  // 目录往上找，别假设任何绝对路径。
  let dir = fromDir;
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, 'node_modules', 'js-yaml');
    if (fs.existsSync(candidate)) {
      const require = createRequire(path.join(dir, 'package.json'));
      return require('js-yaml');
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('找不到 js-yaml（DSH 应该自带）；从 ' + fromDir + ' 往上找了 6 层');
}

/** `baseURL` 的路径正好是 `/v1` 才算「网关那个 provider」。 */
function isGatewayBaseUrl(value) {
  if (typeof value !== 'string' || value === '') return false;
  try {
    return new URL(value).pathname === '/v1';
  } catch {
    return false;
  }
}

const [patchPath, outPath] = process.argv.slice(2);
if (!patchPath || !outPath) {
  console.error('用法: node extract-providers.mjs <cordis.patch.yml> <providers.json>');
  process.exit(1);
}
if (!fs.existsSync(patchPath)) {
  console.error('找不到 ' + patchPath);
  process.exit(1);
}

const yaml = loadYaml(path.dirname(patchPath));
const doc = yaml.load(fs.readFileSync(patchPath, 'utf8'));
const entries = Array.isArray(doc) ? doc : [];

const llm = entries.find((e) => e && e.id === 'llm-pi-ai');
if (!llm) {
  console.error('cordis.patch.yml 里没有 id: llm-pi-ai 条目');
  process.exit(1);
}
const providers = (llm.config && llm.config.providers) || {};

const picked = {};
const stripped = [];
for (const [name, cfg] of Object.entries(providers)) {
  if (!cfg || typeof cfg !== 'object') continue;
  if (!isGatewayBaseUrl(cfg.baseURL)) continue;

  // 骨架：保留展示字段 + 其它未知键，剥掉本机专属的那几项。
  const skeleton = {};
  for (const [key, value] of Object.entries(cfg)) {
    if (LOCAL_ONLY_KEYS.includes(key)) continue;
    if (!KEEP_KEYS.includes(key)) {
      // 未知键也带上，但记录一下，方便发现「profile 换了形状」。
      stripped.push(`${name}.${key}（未知键，原样保留）`);
    }
    skeleton[key] = value;
  }
  picked[name] = skeleton;
}

if (Object.keys(picked).length === 0) {
  console.error(
    '一个网关 provider 都没抽到：profile 里没有 baseURL 路径正好为 /v1 的 provider。\n' +
      '  先在 DSH 的「积分桥」面板填一次网关地址 + API key，让它把 provider 写好。',
  );
  process.exit(1);
}

fs.writeFileSync(outPath, JSON.stringify(picked, null, 2) + '\n', 'utf8');
for (const [name, cfg] of Object.entries(picked)) {
  console.log(`  ${name}: displayName=${JSON.stringify(cfg.displayName || cfg.name || '')}（已剥离 apiKeyEnv / baseURL / models）`);
}
for (const note of stripped) console.log(`  注意: ${note}`);
console.log('已写入 ' + outPath);
