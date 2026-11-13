import fs from 'node:fs';

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

eval(fs.readFileSync('lib/client.js', 'utf8'));
const ex = captured.factory((n) => { if (n === 'react') return React; throw new Error(n); });

let gate = null;
ex.apply({
  get: () => undefined,
  inject: (deps, cb) =>
    cb({
      modelDirectories: { directoryFor: () => ({ store: {} }) },
      slots: { inject: (n, f) => f(), register: (a, comp) => { if (a.name === 'conversation.input.right') gate = comp; } },
    }),
  slots: { inject: (n, f) => f(), register: (a, comp) => { if (a.name === 'conversation.input.right') gate = comp; } },
});

function findPicker(node) {
  if (!node || typeof node !== 'object') return null;
  if (typeof node.t === 'function' && node.p && Object.keys(node.p).join() === 'modelId') return node.t;
  for (const kid of node.k || []) {
    const hit = findPicker(kid);
    if (hit) return hit;
  }
  return null;
}

function textOf(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node === 'object' && node.k) return (node.k || []).map(textOf).join(' ');
  return '';
}

function stubFetch(upstreamEntry, profileValue) {
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes(':7802')) {
      return { ok: true, json: async () => ({ ok: true, models: [{ id: MODEL, contextWindow: profileValue, maxTokens: 128000 }] }) };
    }
    if (u.includes('/api/health')) return { ok: true, json: async () => ({ accounts: [{ id: 'wb-1' }] }) };
    if (u.includes('/api/channels')) {
      return {
        ok: true,
        json: async () => ({ channels: [{ id: 'workbuddy', label: 'WorkBuddy', idPrefix: 'wb', letter: 'W', icon: null }] }),
      };
    }
    if (u.includes('/api/model-config')) {
      const doc = { ok: true, upstream: {} };
      if (upstreamEntry) doc.upstream[MODEL] = upstreamEntry;
      return { ok: true, json: async () => doc };
    }
    if (u.includes('/badge')) {
      return {
        ok: true,
        json: async () => ({ channel: 'workbuddy', title: 'WorkBuddy · 账号1', amount: '1550', today: '今日 0', note: null }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

async function getPicker(upstreamEntry, profileValue) {
  stubFetch(upstreamEntry, profileValue);
  runs.clear();
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
  const picker = findPicker(strip);
  if (!picker) {
    const st = runs.get(gate) ? runs.get(gate).states[0] : undefined;
    throw new Error(`没找到 ContextPicker（CreditsGate 的 accounts=${JSON.stringify(st)}）`);
  }
  return picker;
}

async function renderPicker(upstreamEntry, profileValue) {
  const ContextPicker = await getPicker(upstreamEntry, profileValue);
  const s = slotOf(ContextPicker);
  s.states = [true, { left: 0, bottom: 100 }, null, false, ''];
  s.idx = 0;
  s.effects = [];
  render(ContextPicker, { modelId: MODEL });
  runEffects(ContextPicker);
  await new Promise((r) => setTimeout(r, 40));
  return textOf(render(ContextPicker, { modelId: MODEL }));
}

let bad = 0;
const check = (name, ok) => {
  console.log((ok ? '  ✓ ' : '  ✗ ') + name);
  if (!ok) bad += 1;
};

const tiers = {
  id: MODEL,
  contextWindow: 1000000,
  lengths: { default: 300000, options: [300000, 600000, 1000000] },
};

console.log('--- A. 有档位表，当前 1M 在表里 ---');
const a = await renderPicker(tiers, 1000000);
console.log('  ' + a.replace(/\s+/gu, ' ').trim());
check('列出 300K / 600K / 1M', /300K/u.test(a) && /600K/u.test(a) && /1M/u.test(a));
check('没有「不在可选档位」', !a.includes('不在可选档位'));
check('没有「超出上限」', !a.includes('超出上限'));

console.log('--- B. 有档位表，当前 500K 不在表里 ---');
const b = await renderPicker(tiers, 500000);
console.log('  ' + b.replace(/\s+/gu, ' ').trim());
check('出现「不在可选档位」', b.includes('不在可选档位'));

console.log('--- C. 拿不到档位表（真实现象） ---');
const c = await renderPicker(null, 1000000);
console.log('  ' + c.replace(/\s+/gu, ' ').trim());
check('标成「固定」', c.includes('固定'));
check('**不**出现「不在可选档位」', !c.includes('不在可选档位'));
check('仍显示当前值 1M', /1M/u.test(c));

console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
process.exit(bad === 0 ? 0 : 1);
