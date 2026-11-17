/**
 * 数据血缘：属性 → 物理列 → 下游产物。
 *
 * 重点验「断点」：没有物理列、却仍被规则/指标/动作消费的属性。
 * 这类东西在面上看起来正常，在真实数据上跑不起来。
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
  const lineage = await import('../lib/lineage.mjs');
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'store-inventory.ir.json'), 'utf8'));
  const clone = () => JSON.parse(JSON.stringify(base));

  console.log('\n覆盖');

  await it('随包资产 28 个属性全部接上物理列，没有断点', () => {
    const l = lineage.buildLineage(clone());
    assert.equal(l.coverage.total, 28);
    assert.equal(l.coverage.mapped, 28);
    assert.equal(l.coverage.percent, 100);
    assert.deepEqual(l.gaps, []);
    assert.match(lineage.describeLineage(l), /28\/28/);
  });

  await it('摘掉一个被消费的 storage 就出现断点，并列出所有下游', () => {
    const ir = clone();
    const inv = ir.objects.find((o) => o.id === 'Inventory');
    delete inv.properties.find((p) => p.name === 'availableQty').storage;
    const l = lineage.buildLineage(ir);
    assert.equal(l.coverage.mapped, 27);
    assert.equal(l.gaps.length, 1);
    const gap = l.gaps[0];
    assert.equal(gap.objectId, 'Inventory');
    assert.equal(gap.property, 'availableQty');
    const used = gap.usedBy.join(' ');
    assert.match(used, /规则 inventory\.lowStockWarning/);
    assert.match(used, /指标 inventory\.stockoutCount/);
    assert.match(used, /动作 adjustInventory/);
    assert.match(used, /流程 inventory\.replenish/);
  });

  await it('既没物理列也没人读的属性进 orphans，不算断点', () => {
    const ir = clone();
    const store = ir.objects.find((o) => o.id === 'Store');
    const openDate = store.properties.find((p) => p.name === 'openDate');
    delete openDate.storage;
    // openDate 也被视图排除在外，所以没人读
    const l = lineage.buildLineage(ir);
    assert.ok(l.orphans.some((o) => o.objectId === 'Store' && o.property === 'openDate'));
    assert.deepEqual(l.gaps.filter((g) => g.property === 'openDate'), []);
  });

  console.log('\n下游');

  await it('规则、指标、动作、视图、流程都能被认出来', () => {
    const l = lineage.buildLineage(clone());
    const kinds = new Set(l.detail.map((d) => d.kind));
    for (const kind of ['rule', 'metric', 'action', 'view', 'process']) {
      assert.ok(kinds.has(kind), '缺少消费方类型：' + kind);
    }
  });

  await it('availableQty 的下游明细对得上', () => {
    const l = lineage.buildLineage(clone());
    const rows = l.detail.filter((d) => d.objectId === 'Inventory' && d.property === 'availableQty');
    const ids = rows.map((r) => r.kind + ':' + r.id).sort();
    assert.ok(ids.includes('rule:inventory.lowStockWarning'));
    assert.ok(ids.includes('metric:inventory.availableTotal'));
    assert.ok(ids.includes('action:adjustInventory'));
    assert.ok(ids.includes('view:store-manager'));
    assert.ok(ids.includes('process:inventory.replenish'));
  });

  await it('columns 只列接了物理列的属性，并带上索引标记', () => {
    const l = lineage.buildLineage(clone());
    assert.equal(l.columns.length, 28);
    const one = l.columns.find((c) => c.property === 'storeId' && c.objectId === 'Inventory');
    assert.ok(one.storage);
    assert.equal(typeof one.indexed, 'boolean');
  });

  await it('没有属性的包不炸，覆盖率给 0 而不是 NaN', () => {
    const l = lineage.buildLineage({ objects: [] });
    assert.equal(l.coverage.total, 0);
    assert.equal(l.coverage.percent, 0);
    assert.equal(lineage.describeLineage(l), '没有可查的属性');
  });

  await it('表达式解析不了时血缘不崩，只是那条下游认不出来', () => {
    const ir = clone();
    ir.rules = [{ id: 'inventory.broken', name: '坏规则', expression: 'availableQty <', severity: 'warn' }];
    const l = lineage.buildLineage(ir);
    assert.equal(l.coverage.total, 28);
    assert.ok(Array.isArray(l.detail));
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
