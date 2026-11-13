import fs from 'node:fs';

const SOURCE = fs.readFileSync('lib/client.js', 'utf8');

const MODEL = 'wb-1/deepseek-v4.1-flash';
let captured = null;
global.window = { __ModuleLoader__: { load: (m) => { captured = m; } } };
global.document = { addEventListener() {}, removeEventListener() {} };
global.window.innerWidth = 1200;
global.window.innerHeight = 800;

const runs = new Map();
let slot = null;
const slotOf = (fn) => {
  if (!runs.has(fn)) runs.set(fn, { states: [], idx: 0, effects: [] });
  return runs.get(fn);
};
const React = {
  useState(init) {
    const s = slot;
    const i = s.idx++;
    if (!(i in s.states)) s.states[i] = typeof init === 'function' ? init() : init;
    return [s.states[i], (v) => { s.states[i] = typeof v === 'function' ? v(s.states[i]) : v; }];
  },
  useCallback: (fn) => { if (slot) slot.idx++; return fn; },
  useEffect: (fn) => { if (slot) slot.effects.push(fn); },
  useRef: () => { if (slot) slot.idx++; return { current: null }; },
  useSyncExternalStore: (sub, get) => get(),
  createElement: (t, p, ...k) => ({ t, p, k }),
};

function render(fn, props) {
  const prev = slot;
  slot = slotOf(fn);
  slot.idx = 0;
  try {
    return fn(props);
  } finally {
    slot = prev;
  }
}

function runEffects(fn) {
  const s = slotOf(fn);
  const fx = s.effects;
  s.effects = [];
  for (const f of fx) f();
  return fx.length;
}

function loadGate() {
  captured = null;
  global.window.__ModuleLoader__ = { load: (m) => { captured = m; } };
  eval(SOURCE);
  const ex = captured.factory((n) => { if (n === 'react') return React; throw new Error(n); });
  let g = null;
  ex.apply({
    get: () => undefined,
    inject: (deps, cb) =>
      cb({
        modelDirectories: { directoryFor: () => ({ store: {} }) },
        slots: { inject: (n, f) => f(), register: (a, comp) => { if (a.name === 'conversation.input.right') g = comp; } },
      }),
    slots: { inject: (n, f) => f(), register: (a, comp) => { if (a.name === 'conversation.input.right') g = comp; } },
  });
  return g;
}

function flatten(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) {
    for (const item of node) flatten(item, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  out.push(node);
  for (const kid of node.k || []) flatten(kid, out);
  return out;
}

function textOf(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node === 'object' && node.k) return (node.k || []).map(textOf).join(' ');
  return '';
}

function stubFetch({ icon = null, letter = 'W', badge = null, badgeFails = false } = {}) {
  const calls = [];
  global.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes(':7802')) return { ok: true, json: async () => ({ configured: true }) };
    if (u.includes('/api/health')) return { ok: true, json: async () => ({ accounts: [{ id: 'wb-1' }] }) };
    if (u.includes('/api/channels')) {
      return {
        ok: true,
        json: async () => ({ channels: [{ id: 'workbuddy', label: 'WorkBuddy', idPrefix: 'wb', letter, icon }] }),
      };
    }
    if (u.includes('/badge')) {
      if (badgeFails) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, json: async () => badge };
    }
    if (u.includes('/api/model-config')) return { ok: true, json: async () => ({ ok: true, upstream: {} }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return calls;
}

async function renderStrip(options) {
  const calls = stubFetch(options);
  runs.clear();
  const gate = loadGate();
  const store = { subscribe() {}, getSnapshot() { return { current: { provider: 'jf', model: MODEL } }; } };
  let strip = null;
  for (let round = 0; round < 5; round += 1) {
    const gateOut = render(gate, { directory: store });
    runEffects(gate);
    if (gateOut && typeof gateOut.t === 'function') {
      strip = render(gateOut.t, gateOut.p);
      runEffects(gateOut.t);
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  return { strip, calls };
}

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}\n      期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}
function checkTrue(name, actual) {
  if (actual) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}`);
  }
}

console.log('--- 1. 插件不再内联图标 ---');
checkTrue('没有 base64 图片字面量', !SOURCE.includes('data:image/png;base64'));
checkTrue('没有 CHANNEL_ICONS 常量表', !SOURCE.includes('CHANNEL_ICONS'));

console.log('\n--- 2. 图标来自网关 ---');
const FAKE_ICON = 'data:image/png;base64,iVBORw0KGgoFAKE';
let result = await renderStrip({
  icon: FAKE_ICON,
  letter: 'W',
  badge: { channel: 'workbuddy', title: 'WorkBuddy · 示例账号', amount: '1550', today: '今日 5', note: null },
});
let nodes = flatten(result.strip);
const img = nodes.find((node) => node.t === 'img');
checkTrue('画出了 <img>', Boolean(img));
check('src 就是网关给的 data URI', img && img.p.src, FAKE_ICON);
check('alt 用通道名', img && img.p.alt, 'WorkBuddy · 示例账号');
checkTrue('文本里有余额', textOf(result.strip).includes('1550'));
checkTrue('文本里有今日用量', textOf(result.strip).includes('今日 5'));

console.log('\n--- 3. 图标缺失时的字母兜底 ---');
result = await renderStrip({
  icon: null,
  letter: 'W',
  badge: { channel: 'workbuddy', title: 'WorkBuddy · 示例账号', amount: '1550', today: '', note: null },
});
nodes = flatten(result.strip);
checkTrue('没有 <img>', !nodes.find((node) => node.t === 'img'));
const letterNode = nodes.find((node) => node.p && node.p['aria-hidden'] === 'true');
checkTrue('画出了字母块（不是留白）', Boolean(letterNode));
check('字母块里是 W', letterNode && textOf(letterNode), 'W');

console.log('\n--- 4. note 的提示 ---');
result = await renderStrip({
  icon: null,
  letter: 'W',
  badge: { channel: 'workbuddy', title: 'WorkBuddy · 示例账号', amount: '—', today: '', note: '上游 503' },
});
nodes = flatten(result.strip);
const noteNode = nodes.find((node) => node.p && node.p.title === '上游 503');
checkTrue('有悬停提示元素', Boolean(noteNode));
checkTrue('主数字是「—」', textOf(result.strip).includes('—'));

console.log('\n--- 5. 只轮询 /badge ---');
checkTrue('请求过 /badge', result.calls.some((u) => u.includes('/badge')));
checkTrue('不再请求 /credits', !result.calls.some((u) => u.includes('/credits')));
checkTrue('不再请求 /usage', !result.calls.some((u) => u.includes('/usage')));
checkTrue('请求过 /api/channels', result.calls.some((u) => u.includes('/api/channels')));

console.log('\n--- 6. 取不到时显示离线 ---');
result = await renderStrip({ icon: null, letter: 'W', badgeFails: true });
checkTrue('文本里有「离线」', textOf(result.strip).includes('离线'));

console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
