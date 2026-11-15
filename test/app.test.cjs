/**
 * App-spec generation tests: metadata → page spec.
 * Run `node test/app.test.cjs`.
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
  const { generateAppSpec } = await import('../lib/app.mjs');
  const ir = JSON.parse(fs.readFileSync(ASSET, 'utf8'));

  console.log('\n整体规格');

  await it('每个对象一页，带来源包与版本', () => {
    const spec = generateAppSpec(ir);
    assert.equal(spec.pageCount, ir.objects.length);
    assert.equal(spec.objectCount, ir.objects.length);
    assert.equal(spec.generatedFrom.packageId, ir.id);
    assert.equal(spec.generatedFrom.version, ir.version);
    assert.equal(spec.appId, ir.id + '.app');
  });

  await it('可以只给指定对象生成页面', () => {
    const spec = generateAppSpec(ir, { objects: ['Inventory'] });
    assert.equal(spec.pageCount, 1);
    assert.equal(spec.pages[0].source, 'Inventory');
  });

  await it('请求不存在的对象时跳过并记一条提示', () => {
    const spec = generateAppSpec(ir, { objects: ['Inventory', 'Ghost'] });
    assert.equal(spec.pageCount, 1);
    assert.ok(spec.notes.some((n) => n.includes('Ghost')));
  });

  console.log('\n列表页');

  await it('列来自属性声明，数值右对齐，枚举用 badge', () => {
    const page = generateAppSpec(ir, { objects: ['Inventory'] }).pages[0];
    const qty = page.columns.find((c) => c.field === 'availableQty');
    assert.equal(qty.align, 'right');
    assert.equal(qty.label, '可售数量');

    const store = generateAppSpec(ir, { objects: ['Store'] }).pages[0];
    const format = store.columns.find((c) => c.field === 'format');
    assert.equal(format.display, 'badge');
  });

  await it('json 类型不进列表列', () => {
    const withJson = JSON.parse(JSON.stringify(ir));
    withJson.objects[0].properties.push({ name: 'extra', label: '附加', type: 'json' });
    const page = generateAppSpec(withJson, { objects: [withJson.objects[0].id] }).pages[0];
    assert.ok(!page.columns.some((c) => c.field === 'extra'));
    assert.ok(page.detailFields.some((f) => f.field === 'extra'), '详情里仍应保留');
  });

  await it('筛选器按类型派生：枚举 → select，日期 → dateRange', () => {
    const store = generateAppSpec(ir, { objects: ['Store'] }).pages[0];
    const format = store.filters.find((f) => f.field === 'format');
    assert.equal(format.kind, 'select');
    assert.deepEqual(format.options, ['大卖场', '标超', '便利店']);
    const openDate = store.filters.find((f) => f.field === 'openDate');
    assert.equal(openDate.kind, 'dateRange');
  });

  await it('主键带在页面上', () => {
    const page = generateAppSpec(ir, { objects: ['Inventory'] }).pages[0];
    assert.deepEqual(page.keyFields, ['storeId', 'skuId']);
  });

  console.log('\n操作表单');

  await it('表单字段来自 action 的 inputSchema，保留必填与枚举', () => {
    const page = generateAppSpec(ir, { objects: ['Inventory'] }).pages[0];
    const adjust = page.actions.find((a) => a.actionId === 'adjustInventory');
    assert.ok(adjust, '应当生成库存调整的操作');
    assert.equal(adjust.approvalRequired, true);
    assert.deepEqual(adjust.form.map((f) => f.field), ['storeId', 'skuId', 'availableQty']);
    assert.ok(adjust.form.every((f) => f.required));
  });

  await it('多 effect 的动作标出 effect 数量', () => {
    const page = generateAppSpec(ir, { objects: ['Inventory'] }).pages[0];
    const transfer = page.actions.find((a) => a.actionId === 'createTransfer');
    assert.equal(transfer.effectCount, 2);
  });

  await it('只有声明没有 effect 的动作不生成表单，并留一条提示', () => {
    const stripped = JSON.parse(JSON.stringify(ir));
    delete stripped.actions.find((a) => a.id === 'startStocktake').effect;
    const page = generateAppSpec(stripped, { objects: ['Inventory'] }).pages[0];
    assert.ok(!page.actions.some((a) => a.actionId === 'startStocktake'));
    assert.ok(generateAppSpec(stripped, { objects: ['Inventory'] }).notes.some((n) => n.includes('只有声明')));
  });

  await it('没有可执行动作的对象页面不带操作', () => {
    const page = generateAppSpec(ir, { objects: ['Supplier'] }).pages[0];
    assert.deepEqual(page.actions, []);
  });

  await it('同一份 IR 生成逐字相同的规格（可做快照对比）', () => {
    assert.equal(JSON.stringify(generateAppSpec(ir)), JSON.stringify(generateAppSpec(ir)));
  });

  const total = pass + failures.length;
  console.log(`\n${pass}/${total} passed`);
  if (failures.length) {
    for (const f of failures) console.error('\n' + f.name + '\n', f.error);
    process.exit(1);
  }
})();
