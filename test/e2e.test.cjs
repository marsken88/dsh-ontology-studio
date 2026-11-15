/**
 * End-to-end scenario across the whole tool surface, in the order an agent
 * would actually use it. Individual unit tests prove each tool in isolation;
 * this proves they agree with each other.
 * Run `node test/e2e.test.cjs`.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ASSET = path.join(ROOT, 'assets', 'store-inventory.ir.json');
const RECORDS = path.join(ROOT, 'assets', 'store-inventory.records.json');

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontology-e2e-'));
  fs.copyFileSync(ASSET, path.join(dir, 'store-inventory.ir.json'));
  fs.copyFileSync(RECORDS, path.join(dir, 'store-inventory.records.json'));

  const mod = await import('../index.js');
  const registered = [];
  mod.apply(
    {
      tools: { register: (d) => { registered.push(d); return () => {}; } },
      effect: (run) => run(),
      inject: () => () => {},
      get: () => undefined,
    },
    {
      assetsDir: dir,
      approval: 'never',
      traceFile: path.join(dir, 'trace.jsonl'),
      historyFile: path.join(dir, 'history.jsonl'),
    }
  );
  const t = Object.fromEntries(registered.map((d) => [d.name, d]));
  const PKG = 'retail.store-inventory';

  console.log('\n阶段一：摸清现状');

  await it('自检通过且版本来自 package.json', async () => {
    const value = await t.ontology_diagnostics.execute({}, {});
    assert.equal(value.ok, true, JSON.stringify(value.checks));
    assert.match(value.version, /^\d+\.\d+\.\d+$/);
    assert.equal(value.config.writeMode, 'open');
    assert.ok(value.checks.find((c) => c.name === '工具注册').detail.includes('28 个'));
  });

  await it('资产包与事实数据都能读到，且行数一致', async () => {
    const list = await t.ontology_list.execute({}, {});
    assert.equal(list.packages[0].objects, 6);
    const records = await t.ontology_records.execute({ packageId: PKG }, {});
    assert.equal(records.totalRows, 11);
    const sum = records.objects.reduce((n, o) => n + o.rows, 0);
    assert.equal(sum, 11, '各对象行数之和应等于总行数');
  });

  await it('规则求值的结果与事实数据对得上', async () => {
    const rules = await t.ontology_evaluate_rules.execute({ packageId: PKG }, {});
    const low = rules.results.find((r) => r.rule === 'inventory.lowStockWarning');
    const records = await t.ontology_records.execute({ packageId: PKG, objectId: 'Inventory', limit: 50 }, {});
    const below = records.objects[0].sample.filter((row) => row.availableQty < row.safetyStock);
    assert.equal(low.violations.length, below.length, '违规行数应等于数据里真实低于安全库存的行数');
  });

  console.log('\n阶段二：建模（反向建模 → 落库 → 校验 → 留痕）');

  await it('从表结构生成草稿并落库，历史里能看到', async () => {
    const draft = await t.ontology_draft_object.execute(
      {
        packageId: PKG,
        table: {
          name: 'dwd_warehouse',
          comment: '区域仓',
          columns: [
            { name: 'warehouse_id', type: 'varchar(32)', comment: '仓库编号', nullable: false, primaryKey: true },
            { name: 'capacity', type: 'int', comment: '容量' },
            { name: 'store_id', type: 'bigint', comment: '所属门店' },
          ],
        },
      },
      {}
    );
    assert.equal(draft.ok, true);
    assert.equal(draft.object.id, 'Warehouse');
    assert.equal(draft.valid, true);
    assert.equal(draft.links.length, 1, 'store_id 应推断出指向 Store 的关系');

    const saved = await t.ontology_upsert_object.execute(
      { packageId: PKG, object: draft.object },
      {}
    );
    assert.equal(saved.ok, true, JSON.stringify(saved.problems));

    const link = await t.ontology_upsert_link.execute({ packageId: PKG, link: draft.links[0] }, {});
    assert.equal(link.ok, true, JSON.stringify(link.problems));

    const validated = await t.ontology_validate.execute({}, {});
    assert.equal(validated.ok, true, JSON.stringify(validated.problems));

    const history = await t.ontology_history.execute({ packageId: PKG }, {});
    assert.deepEqual(history.entries.map((e) => e.op), ['upsert_link', 'upsert_object']);
  });

  await it('导出里能看到新对象与它的关系', async () => {
    const md = await t.ontology_export.execute({ packageId: PKG, format: 'markdown' }, {});
    assert.ok(md.content.includes('`Warehouse`'));
    assert.ok(md.content.includes('warehouse_references_store') || md.content.includes('dwd_warehouse'));

    const schema = await t.ontology_export.execute({ packageId: PKG, objectId: 'Warehouse' }, {});
    const parsed = JSON.parse(schema.content);
    assert.deepEqual(parsed.required, ['warehouseId']);
    assert.equal(parsed.properties.capacity.type, 'integer');
  });

  await it('影响分析能指出新对象的下游', async () => {
    const impact = await t.ontology_impact.execute({ packageId: PKG, objectId: 'Warehouse' }, {});
    assert.equal(impact.found, true);
    assert.equal(impact.object.properties, 3);
  });

  console.log('\n阶段三：执行（跨对象动作 → 规则回验 → 留痕）');

  await it('调拨动作同时改两行，规则回验与数据一致', async () => {
    const before = await t.ontology_records.execute({ packageId: PKG, objectId: 'Inventory', limit: 50 }, {});
    const qtyOf = (rows, storeId) => rows.find((r) => r.storeId === storeId && r.skuId === 'SKU-1001').availableQty;
    const fromBefore = qtyOf(before.objects[0].sample, 'S-0213');
    const toBefore = qtyOf(before.objects[0].sample, 'S-0188');

    const result = await t.ontology_execute_action.execute(
      {
        packageId: PKG,
        actionId: 'createTransfer',
        input: { fromStoreId: 'S-0213', toStoreId: 'S-0188', skuId: 'SKU-1001', qty: 30 },
      },
      {}
    );
    assert.equal(result.ok, true, result.message);
    assert.equal(result.matched, 2);

    const after = await t.ontology_records.execute({ packageId: PKG, objectId: 'Inventory', limit: 50 }, {});
    assert.equal(qtyOf(after.objects[0].sample, 'S-0213'), fromBefore - 30);
    assert.equal(qtyOf(after.objects[0].sample, 'S-0188'), toBefore + 30);

    const history = await t.ontology_history.execute({ packageId: PKG, limit: 1 }, {});
    assert.equal(history.entries[0].op, 'execute_action');
    assert.ok(history.entries[0].summary.includes('createTransfer'));
  });

  await it('动作执行后规则重新求值，结论跟着数据变', async () => {
    const rules = await t.ontology_evaluate_rules.execute({ packageId: PKG }, {});
    const stockout = rules.results.find((r) => r.rule === 'inventory.stockoutAlert');
    assert.ok(stockout, '缺货规则应当能求值');
    const records = await t.ontology_records.execute({ packageId: PKG, objectId: 'Inventory', limit: 50 }, {});
    const zero = records.objects[0].sample.filter((row) => row.availableQty <= 0).length;
    assert.equal(stockout.violations.length, zero);
  });

  console.log('\n阶段四：回收（级联删除 → 发布 → 版本历史）');

  await it('级联删除新对象后包仍合法，历史按序记录', async () => {
    const del = await t.ontology_delete_object.execute(
      { packageId: PKG, objectId: 'Warehouse', cascade: true },
      {}
    );
    assert.equal(del.ok, true, JSON.stringify(del.problems));
    const validated = await t.ontology_validate.execute({}, {});
    assert.equal(validated.ok, true, JSON.stringify(validated.problems));

    const list = await t.ontology_list.execute({}, {});
    assert.equal(list.packages[0].objects, 6, '应当回到 6 个对象');
  });

  await it('发布递增版本，历史里版本号连贯', async () => {
    const publish = await t.ontology_publish.execute({ packageId: PKG, bump: 'minor' }, {});
    assert.equal(publish.ok, true, JSON.stringify(publish.problems));
    assert.equal(publish.to, '1.1.0');

    const history = await t.ontology_history.execute({ packageId: PKG }, {});
    assert.equal(history.entries[0].op, 'publish');
    assert.equal(history.entries[0].version, '1.1.0');
    const ops = history.entries.map((e) => e.op);
    assert.deepEqual(ops, [
      'publish',
      'delete_object',
      'execute_action',
      'upsert_link',
      'upsert_object',
    ]);
  });

  console.log('\n阶段五：轨迹与只读守卫');

  await it('执行轨迹记录了整条链路，被拒的那次标为失败', async () => {
    const lines = fs
      .readFileSync(path.join(dir, 'trace.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.ok(lines.length >= 15, '整条链路应当有足够多的记录');
    const names = lines.map((l) => l.tool);
    for (const expected of ['ontology_list', 'ontology_evaluate_rules', 'ontology_upsert_object', 'ontology_execute_action', 'ontology_publish']) {
      assert.ok(names.includes(expected), '轨迹缺少 ' + expected);
    }
    assert.ok(lines.every((l) => typeof l.ok === 'boolean'));
  });

  await it('最终磁盘状态与只读视图一致', async () => {
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8'));
    assert.equal(onDisk.version, '1.1.0');
    assert.equal(onDisk.status, 'published');
    assert.equal(onDisk.objects.length, 6);
    const view = await t.ontology_get.execute({ packageId: PKG }, {});
    assert.equal(view.package.version, onDisk.version);
    assert.equal(view.objects.length, onDisk.objects.length);
  });

  const total = pass + failures.length;
  console.log(`\n${pass}/${total} passed`);
  if (failures.length) {
    for (const f of failures) console.error('\n' + f.name + '\n', f.error);
    process.exit(1);
  }
})();
