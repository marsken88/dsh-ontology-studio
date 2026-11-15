/**
 * Sample-payload reverse modeling + regression planning tests.
 * Run `node test/sample.test.cjs`.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ASSET = path.join(ROOT, 'assets', 'store-inventory.ir.json');

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
  const { draftFromSample, inferProperty } = await import('../lib/sample.mjs');
  const { buildRegressionPlan } = await import('../lib/regression.mjs');
  const ir = JSON.parse(fs.readFileSync(ASSET, 'utf8'));

  console.log('\n按样例推断类型');

  await it('基本类型从值推断', () => {
    assert.equal(inferProperty('a', 1).type, 'integer');
    assert.equal(inferProperty('a', 1.5).type, 'number');
    assert.equal(inferProperty('a', true).type, 'boolean');
    assert.equal(inferProperty('a', 'x').type, 'string');
  });

  await it('日期与时间从字符串格式识别', () => {
    assert.equal(inferProperty('a', '2026-11-15').type, 'date');
    assert.equal(inferProperty('a', '2026-11-15T10:00:00+08:00').type, 'datetime');
  });

  await it('空值与数组/嵌套对象降级并给出说明', () => {
    const nullish = inferProperty('a', null);
    assert.equal(nullish.type, 'string');
    assert.ok(nullish.note.includes('空值'));
    assert.equal(inferProperty('a', [1, 2]).type, 'json');
    assert.equal(inferProperty('a', { b: 1 }).type, 'json');
  });

  console.log('\n草稿生成');

  const sample = {
    warehouse_no: 'WH-01',
    warehouse_name: '华东仓',
    capacity: 12000,
    store_id: 'S-0213',
    created_at: '2026-11-15T10:00:00+08:00',
    active: true,
  };

  await it('键名归一为 camelCase，主键取 *No 而不是外键', () => {
    const draft = draftFromSample(sample, { objectId: 'warehouse', objects: ir.objects, name: '仓库' });
    assert.equal(draft.object.id, 'Warehouse');
    assert.deepEqual(draft.object.keys, ['warehouseNo']);
    assert.deepEqual(draft.object.properties.map((p) => p.name), [
      'warehouseNo',
      'warehouseName',
      'capacity',
      'storeId',
      'createdAt',
      'active',
    ]);
  });

  await it('外键推出去向关系', () => {
    const draft = draftFromSample(sample, { objectId: 'warehouse', objects: ir.objects });
    assert.deepEqual(draft.links.map((l) => [l.id, l.target]), [['warehouse_references_store', 'Store']]);
  });

  await it('有 id 时优先用 id 作主键', () => {
    const draft = draftFromSample({ id: 'x', store_id: 'S-01' }, { objectId: 'foo', objects: ir.objects });
    assert.deepEqual(draft.object.keys, ['id']);
  });

  await it('对象数组按第一条推断并给出提示', () => {
    const draft = draftFromSample([sample, sample], { objectId: 'warehouse', objects: ir.objects });
    assert.ok(draft.object);
    assert.ok(draft.problems.some((p) => p.code === 'array-sample'));
  });

  await it('空数组与非法样例明确报错', () => {
    assert.equal(draftFromSample([], {}).object, null);
    assert.equal(draftFromSample('nope', {}).object, null);
  });

  await it('嵌套对象被抽成独立对象', () => {
    const draft = draftFromSample({ id: 'a1', address: { city: '上海', detail: 'xx路' } }, { objectId: 'shop' });
    assert.equal(draft.nested.length, 1);
    assert.equal(draft.nested[0].id, 'Address');
    assert.ok(draft.problems.some((p) => p.code === 'nested-object'));
  });

  await it('同一段样例永远产出同样的草稿', () => {
    const a = JSON.stringify(draftFromSample(sample, { objectId: 'warehouse', objects: ir.objects }));
    const b = JSON.stringify(draftFromSample(sample, { objectId: 'warehouse', objects: ir.objects }));
    assert.equal(a, b);
  });

  console.log('\n回归清单');

  await it('给出规则/动作/关系/Agent/产物五类检查项', () => {
    const plan = buildRegressionPlan(ir, 'Inventory');
    assert.ok(plan.items.length >= 5);
    for (const kind of ['object', 'rules', 'action', 'links', 'agent', 'export']) {
      assert.ok(plan.items.some((i) => i.kind === kind), '缺少 ' + kind);
    }
    assert.ok(plan.summary.rules >= 2);
    assert.ok(plan.summary.agents >= 1);
  });

  await it('每条都带「怎么验」的具体做法', () => {
    const plan = buildRegressionPlan(ir, 'Inventory');
    const ruleItem = plan.items.find((i) => i.kind === 'rules');
    assert.ok(ruleItem.how.includes('ontology_evaluate_rules'));
    const actionItem = plan.items.find((i) => i.kind === 'action');
    assert.ok(actionItem.how.includes('ontology_execute_action'));
  });

  await it('没有规则引用的对象如实说明', () => {
    const plan = buildRegressionPlan(ir, 'Supplier');
    const rules = plan.items.find((i) => i.kind === 'rules');
    assert.ok(rules.title.includes('没有规则'));
    assert.equal(rules.how, '—');
  });

  await it('对象不存在返回 null', () => {
    assert.equal(buildRegressionPlan(ir, 'Ghost'), null);
  });

  const total = pass + failures.length;
  console.log(`\n${pass}/${total} passed`);
  if (failures.length) {
    for (const f of failures) console.error('\n' + f.name + '\n', f.error);
    process.exit(1);
  }
})();
