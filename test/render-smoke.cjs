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

class Component {
  constructor(props) {
    this.props = props || {};
    this.state = {};
  }
  setState(patch) {
    this.state = Object.assign({}, this.state, typeof patch === 'function' ? patch(this.state) : patch);
  }
}

function makeReact(pageOverride) {
  let hookIndex = 0;
  let forcedPage = null;
  let liveState = null;
  return {
    __setPage(p) { forcedPage = p; hookIndex = 0; },
    /** Feed the panel a resolved Host state so the live model path renders too. */
    __setLive(state) { liveState = state; },
    createElement(type, props, ...children) {
      if (typeof type === 'function' && type.prototype && type.prototype.render) {
        const instance = new type(Object.assign({}, props, { children }));
        return instance.render();
      }
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
    Component: Component,
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
  agents: {
    agents: [
      { id: 'stock-replenisher', name: '库存补货 Agent', model: 'deepseek-v4.1-flash', status: 'published', usesObjects: ['Inventory'], tools: ['ontology_get'], actions: [], evalTarget: '≥85%' },
      { id: 'store-inspector', name: '巡店助手 Agent', model: 'deepseek-v4.1-flash', status: 'gray', usesObjects: ['Store'], tools: ['ontology_get'], actions: [], evalTarget: '≥90%' },
    ],
    usage: { byTool: { 'stock-replenisher': { ontology_get: { ok: 2, fail: 0 } } }, unattributed: 1, scanned: 3 },
  },
  appSpec: {
    appId: ir.id + '.app',
    title: ir.name,
    generatedFrom: { packageId: ir.id, version: ir.version },
    objectCount: 2,
    pageCount: 2,
    pages: [
      { id: 'Inventory.list', kind: 'list', title: '库存', source: 'Inventory', keyFields: ['storeId', 'skuId'],
        columns: [
          { field: 'storeId', label: '门店编号', type: 'string', align: 'left', display: 'text', sortable: true },
          { field: 'availableQty', label: '可售数量', type: 'number', align: 'right', display: 'text', sortable: true },
        ],
        filters: [{ field: 'updatedAt', label: '更新时间', kind: 'dateRange' }],
        detailFields: [],
        actions: [{ actionId: 'adjustInventory', label: '库存调整', approvalRequired: true, effectCount: 1, form: [{ field: 'storeId', label: '门店编号', type: 'string', required: true }] }] },
    ],
    notes: [],
  },
  catalog: {
    available: [
      { id: 'retail.member-loyalty', name: '会员权益资产包', version: '0.2.0', objects: 3, rules: 2, actions: 2, dependsOn: ['retail.store-inventory'], installed: false, ok: true },
    ],
    installed: [{ id: ir.id, version: ir.version, objects: 6 }],
    missingDeps: [],
  },
  history: [
    { ts: 1700000002000, packageId: ir.id, version: '1.1.0', op: 'upsert_object', target: 'Warehouse', summary: '新增对象 Warehouse' },
    { ts: 1700000001000, packageId: ir.id, version: '1.0.0', op: 'publish', target: ir.id, summary: '发布 1.0.0 → 1.1.0' },
  ],
  lineage: {
    packageId: ir.id,
    summary: '28/28 个属性接上了物理列（100%），没有断点',
    coverage: { total: 28, mapped: 28, unmapped: 0, percent: 100 },
    gaps: [{ objectId: 'Inventory', property: 'availableQty', usedBy: ['规则 inventory.lowStockWarning'] }],
    orphans: [],
    columns: [],
  },
  processPlans: {
    packageId: ir.id,
    plans: [
      {
        id: 'inventory.replenish',
        name: '缺货补货',
        ok: true,
        canRun: true,
        needsHuman: true,
        blockedAt: null,
        structure: '检查(确认存在缺货) → 人工确认(店长确认补货量) → 执行(调整可售数量)',
        summary: '3 步推演完毕：1 步通过，1 步会执行，1 步待人确认',
        steps: [],
      },
    ],
  },
  metrics: {
    packageId: ir.id,
    recordsFile: '<assets>/store-inventory.records.json',
    metrics: [
      { id: 'inventory.stockoutCount', name: '缺货记录数', object: 'Inventory', aggregation: 'count', field: null, filter: 'availableQty <= 0', value: 1, matched: 1, total: 5, problems: [] },
      { id: 'inventory.availableTotal', name: '可售总量', object: 'Inventory', aggregation: 'sum', field: 'availableQty', filter: null, value: 653, matched: 5, total: 5, problems: [] },
    ],
  },
  views: {
    packageId: ir.id,
    total: { objects: 6, properties: 28 },
    views: [
      {
        id: 'store-manager',
        name: '门店店长视角',
        description: '只看库存与商品',
        summary: '2 个对象 / 5 个属性，本视图内的对象还有 5 个属性未暴露，另有 4 个对象完全不可见',
        coverage: [
          { objectId: 'Inventory', total: 8, covered: ['storeId', 'skuId', 'availableQty', 'safetyStock'], uncovered: ['onHandQty'] },
          { objectId: 'Product', total: 5, covered: ['productId'], uncovered: ['productName'] },
        ],
      },
    ],
  },
  sync: {
    count: 1,
    sources: [
      {
        packageId: 'demo.stock',
        objectId: 'Stock',
        path: 'D:/data/stock.csv',
        at: '2026-11-16T09:00:00.000Z',
        rowCount: 3,
        columnCount: 5,
        runs: 2,
        summary: '上次同步 2026-11-16 17:00:00：3 行，行数 +1；新增列 lead_time',
      },
    ],
  },
  records: {
    file: '<assets>/store-inventory.records.json',
    totalRows: 11,
    objects: [
      { id: 'Inventory', rows: 5, sample: [
        { storeId: 'S-0213', skuId: 'SKU-1001', availableQty: 80, safetyStock: 150 },
        { storeId: 'S-0213', skuId: 'SKU-1002', availableQty: 0, safetyStock: 20 },
      ] },
      { id: 'Store', rows: 2, sample: [{ storeId: 'S-0213', storeName: '人民广场店' }] },
    ],
  },
  traceSummary: {
    total: 2,
    ok: 1,
    failed: 1,
    successRate: 50,
    avgMs: 6,
    p50Ms: 6,
    p95Ms: 9,
    slowestMs: 9,
    tools: [{ tool: 'ontology_get', calls: 1, fails: 1, successRate: 0, avgMs: 9 }],
    topFailing: [{ tool: 'ontology_get', calls: 1, fails: 1, successRate: 0, avgMs: 9 }],
    firstAt: 1700000000000,
    lastAt: 1700000001000,
  },
  traces: [
    { ts: 1700000000000, tool: 'ontology_list', ok: true, ms: 4, summary: 'ontology_list: ' },
    { ts: 1700000001000, tool: 'ontology_get', ok: false, ms: 9, summary: 'ontology_get: nope', error: '资产包不存在：nope' },
  ],
});
const expectations = {
  overview: ['实时资产', ir.id, '刷新', '需要审批的动作'],
  ontology: ['Inventory', 'availableQty', 'belongsTo', '+ 新增关系', '+ 新建', '图谱', '要重验什么', '与市场版本对比'],
  observability: ['执行轨迹（实时）', 'ontology_list', 'ontology_get', '成功率', '50%', '最常失败'],
  logic: ['inventory.lowStockWarning', 'availableQty < safetyStock', '仅声明', '在示例数据上跑一次', '+ 新增规则', '需审批', '指标口径', 'inventory.stockoutCount', '653', '业务流程（推演）', '缺货补货', '待人工确认'],
  data: ['事实数据', '属性覆盖', 'Inventory · 5 行', 'CSV 数据源同步', 'demo.stock', '新增列 lead_time'],
  governance: ['变更历史', 'upsert_object', 'v1.1.0', '角色视角（视图）', 'store-manager', 'Inventory 4/8', '数据血缘', '1 处断点'],
  marketplace: ['资产市场', '会员权益资产包', '可安装'],
  app: ['页面清单', '操作表单', 'adjustInventory', '渲染预览'],
  agent: ['Agent 花名册', 'stock-replenisher', '2 次'],
};
for (const p of Object.keys(expectations)) {
  React.__setPage(p === 'overview' ? null : p);
  const json = JSON.stringify(panel({}));
  for (const needle of expectations[p]) {
    if (!json.includes(needle)) throw new Error(`live ${p} page is missing ${needle}`);
  }
  console.log('live  :', p.padEnd(14), 'ok', (json.length / 1024).toFixed(1) + 'KB tree');
}
// 同一个卡片被插两次不会让上面的断言失败，只会让人看到重复内容；单独守一下。
React.__setPage('governance');
const govJson = JSON.stringify(panel({}));
for (const title of ['角色视角（视图）', '数据血缘']) {
  const count = govJson.split(title).length - 1;
  if (count > 1) throw new Error(`${title} 渲染了 ${count} 次`);
}

// 连上宿主、但实例是全新的：这几个页面必须渲染 live 空态，不能退回演示数据。
React.__setLive({
  phase: 'live',
  value: { dir: '<assets>', missingDir: false, packages: [{ id: ir.id, ok: true }], problems: [] },
  file: '<assets>/store-inventory.ir.json',
  ir,
  error: null,
  agents: { agents: [], usage: { byTool: {}, unattributed: 0, scanned: 0 } },
  appSpec: { appId: ir.id + '.app', title: ir.name, generatedFrom: { packageId: ir.id, version: ir.version }, objectCount: 0, pageCount: 0, pages: [], notes: [] },
  catalog: { available: [], installed: [], missingDeps: [] },
  history: [],
  records: null,
  sync: null,
  views: { packageId: ir.id, views: [], total: { objects: 6, properties: 28 } },
  lineage: null,
  metrics: { packageId: ir.id, metrics: [], recordsFile: '' },
  processPlans: { packageId: ir.id, plans: [] },
  traceSummary: null,
  traces: [],
});

// 正向断言就够：这些空态串只出现在 live 分支里，退回演示页时一个都不会出现。
// （不做「不含演示数据」的反向断言：live 页的说明文字里本来就会提到这四个字。）
const emptyExpect = {
  governance: ['还没有任何变更记录'],
  data: ['没有事实数据文件'],
  agent: ['还没有声明任何 Agent'],
  app: ['页面清单'],
};
for (const p of Object.keys(emptyExpect)) {
  React.__setPage(p);
  const json = JSON.stringify(panel({}));
  for (const needle of emptyExpect[p]) {
    if (!json.includes(needle)) throw new Error(`空实例的 ${p} 页缺少空态「${needle}」`);
  }
  console.log('live empty:', p.padEnd(12), 'ok');
}

React.__setLive(null);

React.__setLive({
  phase: 'live',
  value: { dir: '<assets>', missingDir: false, packages: [{ id: ir.id, ok: true }], problems: [] },
  file: '<assets>/store-inventory.ir.json',
  ir,
  error: null,
  traces: [],
  records: null,
  history: [],
});
React.__setPage('observability');
{
  const emptyJson = JSON.stringify(panel({}));
  if (!emptyJson.includes('还没有任何工具调用记录')) throw new Error('live 但零轨迹时应显示空状态');
  if (emptyJson.includes('补货准确率')) throw new Error('live 时不应再渲染演示轨迹');
  console.log('live  : observability(空) ok');
}

console.log('\nall render smoke checks passed');
