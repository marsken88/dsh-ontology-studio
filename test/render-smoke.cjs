/**
 * Offline render smoke test for the Ontology Studio client half.
 * Stubs React + the module loader, runs the factory, applies it to a fake
 * context, then renders every page and asserts the tree is non-empty.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'client.js');
const source = fs.readFileSync(SRC, 'utf8');

function makeReact(pageOverride) {
  let hookIndex = 0;
  let forcedPage = null;
  let liveState = null;
  return {
    __setPage(p) { forcedPage = p; hookIndex = 0; },
    /** Feed the panel a resolved Host state so the live model path renders too. */
    __setLive(state) { liveState = state; },
    createElement(type, props, ...children) {
      if (typeof type === 'function') {
        // expand function components so their bodies execute
        return type(Object.assign({}, props, { children }));
      }
      return { type, props: props || {}, children };
    },
    useState(init) {
      hookIndex += 1;
      if (liveState && init && typeof init === 'object' && init.phase === 'loading') {
        return [liveState, () => {}];
      }
      if (init === 'overview' && forcedPage) return [forcedPage, () => {}];
      if (init === 'Inventory' && forcedPage) return ['Inventory', () => {}];
      return [init, () => {}];
    },
    useMemo(fn) { return fn(); },
    /** Effects never run here: the panel must render its fallback data on a cold start. */
    useEffect() { return undefined; },
  };
}

let mod = null;
const sandbox = {
  window: { __ModuleLoader__: { load(m) { mod = m; } } },
  console,
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'client.js' });

if (!mod) throw new Error('module was not registered on window.__ModuleLoader__');
if (mod.id !== 'dsh-ontology-studio') throw new Error('unexpected module id: ' + mod.id);

const registrations = [];
const React = makeReact(null);
const api = mod.factory((name) => {
  if (name === 'react') return React;
  throw new Error('unexpected require: ' + name);
});

const fakeCtx = {
  slots: {
    inject(owner, cb) { const d = cb(); return () => { if (typeof d === 'function') d(); }; },
    register(decl, Comp) { registrations.push({ decl, Comp }); return () => {}; },
  },
  effect(run) { const d = run(); return d; },
};

api.apply(fakeCtx);

console.log('registrations:');
for (const r of registrations) console.log('  ', JSON.stringify(r.decl));

const expectSlots = ['main', 'sidebar.panellist'];
for (const s of expectSlots) {
  if (!registrations.some((r) => r.decl.name === s)) throw new Error('missing slot registration: ' + s);
}

const panel = registrations.find((r) => r.decl.name === 'main').Comp;
const icon = registrations.find((r) => r.decl.name === 'sidebar.panellist').Comp;

// icon: both states
for (const active of [false, true]) {
  const tree = icon({ size: 16, active });
  if (!tree) throw new Error('icon rendered nothing');
}
console.log('icon  : ok (size/active owner props accepted)');

// pages
const pages = ['overview', 'ontology', 'data', 'logic', 'agent', 'app', 'governance', 'marketplace', 'observability'];
for (const p of pages) {
  React.__setPage(p === 'overview' ? null : p);
  const tree = panel({});
  const json = JSON.stringify(tree);
  if (!json || json.length < 200) throw new Error('page rendered suspiciously little: ' + p);
  console.log('page  :', p.padEnd(14), 'ok', (json.length / 1024).toFixed(1) + 'KB tree');
}

// live-model pass: the panel must render Host-owned data, not only the fallback
const ir = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'store-inventory.ir.json'), 'utf8'));
React.__setLive({
  phase: 'live',
  value: { dir: '<assets>', missingDir: false, packages: [{ id: ir.id, ok: true }], problems: [] },
  file: '<assets>/store-inventory.ir.json',
  ir,
  error: null,
});
for (const p of ['overview', 'ontology']) {
  React.__setPage(p === 'overview' ? null : p);
  const json = JSON.stringify(panel({}));
  for (const needle of ['实时资产', ir.id, 'Inventory', '已发布']) {
    if (!json.includes(needle)) throw new Error(`live ${p} page is missing ${needle}`);
  }
  console.log('live  :', p.padEnd(14), 'ok', (json.length / 1024).toFixed(1) + 'KB tree');
}
React.__setLive(null);

console.log('\nall render smoke checks passed');
