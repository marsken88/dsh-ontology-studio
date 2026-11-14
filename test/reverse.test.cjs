/**
 * Reverse-modeling tests: table description → ontology draft.
 * Run `node test/reverse.test.cjs`.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
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
  const {
    mapType,
    camelCase,
    pascalCase,
    snakeCase,
    objectIdFromTable,
    draftObjectFromTable,
    validateDraft,
  } = await import('../lib/reverse.mjs');
  const { validateIr } = await import('../lib/ir.mjs');

  const ir = JSON.parse(fs.readFileSync(ASSET, 'utf8'));

  console.log('\n类型与命名');

  await it('常见 SQL 类型映射到本体类型', () => {
    assert.equal(mapType('varchar(64)').type, 'string');
    assert.equal(mapType('bigint').type, 'integer');
    assert.equal(mapType('decimal(18,2)').type, 'money');
    assert.equal(mapType('double').type, 'number');
    assert.equal(mapType('timestamp').type, 'datetime');
    assert.equal(mapType('date').type, 'date');
    assert.equal(mapType('json').type, 'json');
    assert.equal(mapType('tinyint(1)').type, 'boolean');
  });

  await it('enum(...) 解析出取值列表', () => {
    const mapped = mapType("enum('normal','low','out')");
    assert.equal(mapped.type, 'enum');
    assert.deepEqual(mapped.enum, ['normal', 'low', 'out']);
  });

  await it('无法识别的类型降级为 string 并记录原类型', () => {
    const mapped = mapType('geom_point');
    assert.equal(mapped.type, 'string');
    assert.equal(mapped.unknownSourceType, 'geom_point');
  });

  await it('命名归一', () => {
    assert.equal(camelCase('store_code'), 'storeCode');
    assert.equal(camelCase('SKU_CODE'), 'skuCode');
    assert.equal(pascalCase('order_items'), 'OrderItems');
    assert.equal(snakeCase('InventorySnapshot'), 'inventory_snapshot');
  });

  await it('表名去前缀并单数化', () => {
    assert.equal(objectIdFromTable('dwd_inventory'), 'Inventory');
    assert.equal(objectIdFromTable('dim_store'), 'Store');
    assert.equal(objectIdFromTable('ods_order_items'), 'OrderItem');
    assert.equal(objectIdFromTable('categories'), 'Category');
    assert.equal(objectIdFromTable('ads_sales'), 'Sale');
  });

  console.log('\ndraftObjectFromTable');

  const table = {
    name: 'dwd_inventory_snapshot',
    comment: '门店库存快照表',
    columns: [
      { name: 'store_code', type: 'varchar(32)', comment: '门店编号', nullable: false, primaryKey: true },
      { name: 'sku_code', type: 'varchar(64)', comment: 'SKU 编号', nullable: false, primaryKey: true },
      { name: 'qty_available', type: 'decimal(18,2)', comment: '可售数量' },
      { name: 'stock_status', type: "enum('normal','low','out')", comment: '库存状态' },
      { name: 'gmt_modified', type: 'timestamp', comment: '更新时间' },
    ],
  };

  await it('生成对象身份、注释与主键', () => {
    const draft = draftObjectFromTable(table, ir);
    assert.equal(draft.object.id, 'InventorySnapshot');
    assert.equal(draft.object.name, '门店库存快照');
    assert.deepEqual(draft.object.keys, ['storeCode', 'skuCode']);
    assert.equal(draft.object.properties.length, 5);
    assert.deepEqual(draft.problems, []);
  });

  await it('主键列与非空列标记为必填', () => {
    const draft = draftObjectFromTable(table, ir);
    const store = draft.object.properties.find((p) => p.name === 'storeCode');
    const qty = draft.object.properties.find((p) => p.name === 'qtyAvailable');
    assert.equal(store.required, true);
    assert.equal(qty.required, undefined);
  });

  await it('没有 primaryKey 标记时回退到 id 列', () => {
    const draft = draftObjectFromTable(
      { name: 'dwd_coupon', columns: [{ name: 'id', type: 'bigint' }, { name: 'name', type: 'varchar(10)' }] },
      ir
    );
    assert.deepEqual(draft.object.keys, ['id']);
    assert.equal(draft.object.properties[0].required, true);
  });

  await it('找不到主键时给出问题而不是猜', () => {
    const draft = draftObjectFromTable(
      { name: 'dwd_x', columns: [{ name: 'a', type: 'varchar(2)' }, { name: 'b', type: 'int' }] },
      ir
    );
    assert.deepEqual(draft.object.keys, []);
    assert.ok(draft.problems.some((p) => p.code === 'no-key'));
  });

  await it('外键列推断关系：精确匹配与限定词匹配', () => {
    const exact = draftObjectFromTable(
      { name: 'dwd_x', columns: [{ name: 'id', type: 'bigint', primaryKey: true }, { name: 'store_id', type: 'bigint' }] },
      ir
    );
    assert.deepEqual(exact.links.map((l) => [l.id, l.target]), [['x_references_store', 'Store']]);

    const qualified = draftObjectFromTable(
      {
        name: 'dwd_transfer_order',
        columns: [
          { name: 'transfer_no', type: 'varchar(32)', primaryKey: true },
          { name: 'from_store_id', type: 'bigint' },
          { name: 'to_store_id', type: 'bigint' },
        ],
      },
      ir
    );
    assert.equal(qualified.links.length, 2);
    assert.equal(new Set(qualified.links.map((l) => l.id)).size, 2, '两个同目标关系必须有不同的 id');
    assert.ok(qualified.links.every((l) => l.target === 'Store'));
  });

  await it('指向未知对象的外键不硬造关系', () => {
    const draft = draftObjectFromTable(
      { name: 'dwd_x', columns: [{ name: 'id', type: 'bigint', primaryKey: true }, { name: 'ghost_id', type: 'bigint' }] },
      ir
    );
    assert.deepEqual(draft.links, []);
  });

  await it('空表 / 无列 / 无名列都有明确报错', () => {
    assert.equal(draftObjectFromTable(null, ir).object, null);
    assert.equal(draftObjectFromTable({ name: 't', columns: [] }, ir).object, null);
    const bad = draftObjectFromTable({ name: 't', columns: [{ name: 'id', type: 'int', primaryKey: true }, { type: 'int' }] }, ir);
    assert.ok(bad.problems.some((p) => p.code === 'bad-column'));
  });

  await it('列名归一后重复会被指出', () => {
    const draft = draftObjectFromTable(
      {
        name: 'dwd_x',
        columns: [
          { name: 'id', type: 'int', primaryKey: true },
          { name: 'store_code', type: 'varchar(2)' },
          { name: 'storeCode', type: 'varchar(2)' },
        ],
      },
      ir
    );
    assert.ok(draft.problems.some((p) => p.code === 'duplicate-column'));
  });

  console.log('\nvalidateDraft');

  await it('草稿并入后整包仍然合法（可直接拿去过 upsert）', () => {
    const draft = draftObjectFromTable(table, ir);
    const check = validateDraft(ir, draft);
    const result = validateIr(check.candidate);
    assert.deepEqual(result.problems, [], JSON.stringify(result.problems, null, 2));
    assert.ok(check.candidate.objects.some((o) => o.id === 'InventorySnapshot'));
  });

  await it('同名对象会被替换而不是重复', () => {
    const draft = draftObjectFromTable(table, ir);
    const check = validateDraft(ir, draft);
    const sameId = check.candidate.objects.filter((o) => o.id === 'InventorySnapshot');
    assert.equal(sameId.length, 1);
  });

  console.log('\n工具层');

  await it('ontology_draft_object 只生成不写盘', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontology-rev-'));
    fs.copyFileSync(ASSET, path.join(dir, 'store-inventory.ir.json'));
    const before = fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8');

    const mod = await import('../index.js');
    const registered = [];
    mod.apply(
      {
        tools: { register: (d) => { registered.push(d); return () => {}; } },
        effect: (run) => run(),
        inject: () => () => {},
        get: () => undefined,
      },
      { assetsDir: dir, trace: false }
    );
    const tool = registered.find((d) => d.name === 'ontology_draft_object');
    assert.ok(tool, '应当注册 ontology_draft_object');

    const result = await tool.execute({ packageId: 'retail.store-inventory', table }, {});
    assert.equal(result.ok, true);
    assert.equal(result.object.id, 'InventorySnapshot');
    assert.equal(result.valid, true);
    assert.equal(fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8'), before, '不得写盘');
  });

  const total = pass + failures.length;
  console.log(`\n${pass}/${total} passed`);
  if (failures.length) {
    for (const f of failures) console.error('\n' + f.name + '\n', f.error);
    process.exit(1);
  }
})();
