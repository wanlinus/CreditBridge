// 安装时用：把包里的 providers.json（网关 provider 的**骨架**）合并进这台机器的 DSH profile。
//
// 合并而不是覆盖，是因为朋友的 cordis.patch.yml 里可能有他自己的配置（别的
// provider、主题、权限预设……）。只动 `llm-pi-ai.config.providers` 下包里带来的那个键，
// 其它一律不动。
//
// **v2 的形态**：provider 只有一个，靠 `baseURL` 路径正好 `/v1` 认出来（v1 那套按通道
// 拆的 `workbuddy` / `trae` 键已经不存在）。包里的骨架**不含** `baseURL` /
// `apiKeyEnv` / `models` / `headers`——那几项是收件人机器的事实：
//
//   - 已经填过的：**保留原值**（重跑安装不能把地址和 key 抹掉）；
//   - 还没填的：留空，等收件人在「积分桥」面板填，插件会把它们写对。
//
// 幂等：重复跑只会把包里的展示字段同步过去，不会越插越多，也不会清掉本机字段。
//
// 用法：node merge-providers.mjs <cordis.patch.yml> <providers.json>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const LLM_ID = 'llm-pi-ai';
const LLM_NAME = '@deepseek-ai/dsh-llm-pi-ai';

function loadYaml(fromDir) {
  // js-yaml 随 DSH 一起装在 profile 的 node_modules 里。优先从目标文件所在目录
  // 往上找（正常布局下第一层就命中），找不到再扫 ~/.dsh/profiles/*/node_modules
  // ——安装脚本可能在别处调用本脚本。
  const candidates = [];
  let dir = fromDir;
  for (let i = 0; i < 6; i += 1) {
    candidates.push(path.join(dir, 'node_modules', 'js-yaml'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const dshRoot = process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.dsh', 'profiles') : '';
  if (dshRoot && fs.existsSync(dshRoot)) {
    for (const profile of fs.readdirSync(dshRoot)) {
      candidates.push(path.join(dshRoot, profile, 'node_modules', 'js-yaml'));
    }
  }
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const require = createRequire(path.join(path.dirname(candidate), '..', 'package.json'));
    return require('js-yaml');
  }
  throw new Error('找不到 js-yaml（DSH 应该自带）；找过 ' + candidates.length + ' 个位置');
}

const [patchPath, providersPath] = process.argv.slice(2);
if (!patchPath || !providersPath) {
  console.error('用法: node merge-providers.mjs <cordis.patch.yml> <providers.json>');
  process.exit(1);
}
if (!fs.existsSync(providersPath)) {
  console.error('找不到 ' + providersPath);
  process.exit(1);
}

const incoming = JSON.parse(fs.readFileSync(providersPath, 'utf8'));
const yaml = loadYaml(path.dirname(patchPath));

// 文件不存在时当作空数组：全新机器上 profile 里可能还没有这个文件。
const raw = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : '';
let doc = raw.trim() === '' ? [] : yaml.load(raw);
if (!Array.isArray(doc)) {
  if (doc === null || doc === undefined) {
    doc = [];
  } else {
    throw new Error(patchPath + ' 的顶层不是 YAML 数组，和 DSH 期望的格式不符');
  }
}
// 改之前的语义快照。用来判断「真的变了没有」——不能拿 dump 出来的文本比，
// js-yaml 会重排缩进和引号，文本几乎必然不同，那样每次都会把原文件的注释洗掉。
const beforeJson = JSON.stringify(doc);

let entry = doc.find((e) => e && e.id === LLM_ID);
if (!entry) {
  // 没有就建一个。name 必须写全限定名，DSH 靠它找到插件。
  entry = { id: LLM_ID, name: LLM_NAME, config: { providers: {} } };
  doc.push(entry);
  console.log('  新建了 id: ' + LLM_ID + ' 条目');
}
if (!entry.config || typeof entry.config !== 'object') entry.config = {};
if (!entry.config.providers || typeof entry.config.providers !== 'object') entry.config.providers = {};

// 只属于「收件人这台机器」的键：包里带的是骨架（没有这几项），合并时**不能**用
// 空值覆盖用户已经填好的内容，否则重跑一次安装就把地址和 key 抹了。
const RECIPIENT_OWNED_KEYS = ['baseURL', 'apiKeyEnv', 'apiKey', 'models', 'headers'];

for (const [name, cfg] of Object.entries(incoming)) {
  const existing = entry.config.providers[name];
  if (existing && typeof existing === 'object') {
    // 已有这个 provider：保留它自己的本机字段，只更新包里带来的展示类字段。
    const merged = { ...cfg };
    for (const key of RECIPIENT_OWNED_KEYS) {
      if (existing[key] !== undefined) merged[key] = existing[key];
    }
    entry.config.providers[name] = merged;
    console.log(`  更新 provider "${name}"（保留已有的 ${Object.keys(existing).filter((k) => RECIPIENT_OWNED_KEYS.includes(k)).join(' / ') || '无本机字段'}）`);
  } else {
    entry.config.providers[name] = cfg;
    console.log(`  新增 provider "${name}"（缺 baseURL / apiKeyEnv，等收件人在面板里填）`);
  }
}

if (JSON.stringify(doc) === beforeJson) {
  console.log('  配置已经是最新的，不写盘（原文件一个字节都没动）');
  process.exit(0);
}

// 先写临时文件再改名，避免写一半断电留下半个 YAML。
//
// 注意：js-yaml 的 dump 会重排整个文件，**原有注释会丢**（YAML 里注释不进入
// 数据模型，任何 parser 都一样）。所以原文件一律先备份，且备份只在第一次
// 创建——重复跑不能把「原始那版」覆盖掉。
const text = yaml.dump(doc, { lineWidth: 120, noRefs: true });
const tmp = patchPath + '.tmp-' + process.pid;
fs.writeFileSync(tmp, text, 'utf8');
const backupPath = patchPath + '.bak-cb-gateway';
if (fs.existsSync(patchPath) && !fs.existsSync(backupPath)) {
  fs.copyFileSync(patchPath, backupPath);
  console.log('  备份 ' + backupPath);
}
fs.renameSync(tmp, patchPath);
console.log('  已写入 ' + patchPath + '（YAML 重排，注释不保留；原件在 .bak-cb-gateway）');
