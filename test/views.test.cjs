/**
 * 视图（角色视角）：声明、校验、投影。
 *
 * 重点验两件事：
 *   1. 声明的属性名必须真的存在 —— 不然「权限」就是一张写着不存在的字段的纸
 *   2. 投影之后看不见的东西要说得清楚（哪些对象、哪些属性、哪些规则仍会越界）
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

let pass = 0;
const failures = [];

async function it(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ok  ', name);
  } catch (error) {
    failures.push({ name, error });
    console.log('  FAIL', name, '\n       ', error.message);
  }
}

(async () => {
  const views = await import('../lib/views.mjs');
  const { validateIr } = await import('../lib/ir.mjs');

  const base = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'assets', 'store-inventory.ir.json'), 'utf8')
  );
  const clone = () => JSON.parse(JSON.stringify(base));

  const storeManagerView = {
    id: 'store-manager',
    name: '门店店长视角',
    description: '只看本店库存与商品，不暴露成本与供应商',
    objects: [
      { objectId: 'Inventory', properties: ['storeId', 'skuId', 'availableQty', 'safetyStock'] },
      { objectId: 'Product', properties: ['productId', 'productName'] },
    ],
  };

  console.log('\n声明与校验');

  await it('合法视图通过整包校验', () => {
    const ir = clone();
    ir.views = [storeManagerView];
    const result = validateIr(ir);
    assert.deepEqual(result.problems, []);
    assert.equal(result.ok, true);
  });

  await it('视图引用不存在的属性会被拒绝（这是重点）', () => {
    const ir = clone();
    ir.views = [{ id: 'x', name: 'X', objects: [{ objectId: 'Inventory', properties: ['costPrice'] }] }];
    const result = validateIr(ir);
    assert.equal(result.ok, false);
    const problem = result.problems.find((p) => p.code === 'dangling-property');
    assert.ok(problem, '应报 dangling-property');
    assert.match(problem.message, /costPrice/);
  });

  await it('视图引用不存在的对象会被拒绝', () => {
    const ir = clone();
    ir.views = [{ id: 'x', name: 'X', objects: [{ objectId: 'Ghost', properties: ['a'] }] }];
    const result = validateIr(ir);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.code === 'dangling-object'));
  });

  await it('视图 id 必须是 kebab-case，且不能重复', () => {
    const ir = clone();
    ir.views = [
      { id: 'StoreManager', name: 'A', objects: [{ objectId: 'Store', properties: ['storeId'] }] },
      { id: 'dup', name: 'B', objects: [{ objectId: 'Store', properties: ['storeId'] }] },
      { id: 'dup', name: 'C', objects: [{ objectId: 'Store', properties: ['storeId'] }] },
    ];
    const result = validateIr(ir);
    assert.ok(result.problems.some((p) => p.code === 'bad-id' && p.path.includes('views[0]')));
    assert.ok(result.problems.some((p) => p.code === 'duplicate' && p.path.includes('views[2]')));
  });

  await it('空视图、空属性列表、未知字段都会被拒绝', () => {
    const ir = clone();
    ir.views = [
      { id: 'empty', name: '空', objects: [] },
      { id: 'noprops', name: '无属性', objects: [{ objectId: 'Store', properties: [] }] },
      { id: 'typo', name: '拼错', objects: [{ objectId: 'Store', properties: ['storeId'] }], objetcs: [] },
    ];
    const result = validateIr(ir);
    assert.ok(result.problems.some((p) => p.code === 'empty' && p.path.includes('objects')));
    assert.ok(result.problems.some((p) => p.code === 'empty' && p.path.includes('properties')));
    assert.ok(result.problems.some((p) => p.code === 'unknown-key'));
  });

  console.log('\n覆盖与描述');

  await it('viewCoverage 算出每个对象暴露了哪些、漏了哪些', () => {
    const ir = clone();
    ir.views = [storeManagerView];
    const view = views.findView(ir, 'store-manager');
    const coverage = views.viewCoverage(ir, view);
    const inventory = coverage.find((c) => c.objectId === 'Inventory');
    assert.ok(inventory.covered.includes('availableQty'));
    assert.equal(inventory.total, 8, 'Inventory 共 8 个属性');
    assert.ok(inventory.uncovered.length > 0, '应有未暴露的属性');
  });

  await it('describeView 一句话说清对象数、属性数、还有多少不可见', () => {
    const ir = clone();
    ir.views = [storeManagerView];
    const line = views.describeView(ir, storeManagerView);
    assert.match(line, /2 个对象 \/ 6 个属性/);
    assert.match(line, /未暴露/);
    assert.match(line, /完全不可见/);
  });

  console.log('\n投影');

  await it('投影只留下视图里的对象与属性', () => {
    const ir = clone();
    ir.views = [storeManagerView];
    const result = views.projectPackage(ir, 'store-manager');
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.ir.objects.map((o) => o.id).sort(),
      ['Inventory', 'Product']
    );
    const inventory = result.ir.objects.find((o) => o.id === 'Inventory');
    assert.deepEqual(
      inventory.properties.map((p) => p.name),
      ['storeId', 'skuId', 'availableQty', 'safetyStock']
    );
    // 原包不能被改
    assert.equal(base.objects.find((o) => o.id === 'Inventory').properties.length, 8);
  });

  await it('看不见的东西都记在 hidden 里，不是悄悄消失', () => {
    const ir = clone();
    ir.views = [storeManagerView];
    const result = views.projectPackage(ir, 'store-manager');
    assert.ok(result.hidden.objects.includes('Supplier'));
    assert.ok(result.hidden.properties.some((p) => p.objectId === 'Product'));
    assert.ok(result.hidden.actions.length > 0, '写不可见对象的动作应被挡在外面');
    assert.ok(result.hidden.agents.length >= 0);
  });

  await it('关系只在两端都可见时保留', () => {
    const ir = clone();
    ir.views = [storeManagerView];
    const result = views.projectPackage(ir, 'store-manager');
    const visible = new Set(result.ir.objects.map((o) => o.id));
    for (const link of result.ir.links) {
      assert.ok(visible.has(link.source) && visible.has(link.target), '关系端点必须都可见');
    }
    assert.ok(result.ir.links.length < base.links.length, '应该比全量少');
    assert.equal(result.hidden.links, base.links.length - result.ir.links.length);
  });

  await it('规则按归属对象保留，越界引用进 leaks 而不是删规则', () => {
    const ir = clone();
    // 一个只暴露 availableQty 的窄视图：lowStockWarning 用到 safetyStock
    ir.views = [{ id: 'narrow', name: '窄', objects: [{ objectId: 'Inventory', properties: ['storeId', 'skuId', 'availableQty'] }] }];
    const result = views.projectPackage(ir, 'narrow');
    assert.ok(result.ir.rules.some((r) => r.id === 'inventory.lowStockWarning'), '规则应保留');
    const leak = result.leaks.find((l) => l.ruleId === 'inventory.lowStockWarning');
    assert.ok(leak, 'lowStockWarning 读 safetyStock，应被记为越界');
    assert.ok(leak.identifiers.includes('safetyStock'));
  });

  await it('动作只保留写入对象全部可见的那些', () => {
    const ir = clone();
    ir.views = [storeManagerView];
    const result = views.projectPackage(ir, 'store-manager');
    for (const action of result.ir.actions) {
      const visible = new Set(result.ir.objects.map((o) => o.id));
      for (const w of action.writes || []) assert.ok(visible.has(w));
    }
  });

  await it('投影结果本身仍然是合法的资产包', () => {
    const ir = clone();
    ir.views = [storeManagerView];
    const result = views.projectPackage(ir, 'store-manager');
    const check = validateIr(result.ir);
    assert.equal(check.ok, true, JSON.stringify(check.problems));
    assert.equal(result.ir.views, undefined, '投影里不再带视图');
  });

  await it('视图不存在时给出可用清单，而不是抛错', () => {
    const ir = clone();
    ir.views = [storeManagerView];
    const missing = views.projectPackage(ir, 'nope');
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'view-not-found');
    assert.match(missing.message, /store-manager/);

    const none = views.projectPackage(ir, '');
    assert.equal(none.code, 'view-missing');
  });

  const total = pass + failures.length;
  console.log(`\n${pass}/${total} passed`);
  if (failures.length) {
    for (const f of failures) console.error('\n' + f.name + '\n', f.error);
    process.exit(1);
  }
})().catch((err) => {
  console.error('FAIL', err && err.stack);
  process.exit(1);
});
