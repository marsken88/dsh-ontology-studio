/**
 * Export tests: IR → JSON Schema / Markdown.
 * Run `node test/export.test.cjs`.
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
  const { objectSchema, packageSchemas, markdownDoc } = await import('../lib/export.mjs');
  const ir = JSON.parse(fs.readFileSync(ASSET, 'utf8'));
  const inventory = ir.objects.find((o) => o.id === 'Inventory');

  console.log('\nobjectSchema');

  await it('必填、类型、主键都映射正确', () => {
    const schema = objectSchema(ir, inventory);
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ['storeId', 'skuId']);
    assert.deepEqual(schema['x-primary-key'], ['storeId', 'skuId']);
    assert.equal(schema.properties.availableQty.type, 'number');
    assert.equal(schema.properties.availableQty.title, '可售数量');
    assert.equal(schema.properties.updatedAt.format, 'date-time');
  });

  await it('enum 属性导出为 enum 取值', () => {
    const store = ir.objects.find((o) => o.id === 'Store');
    const schema = objectSchema(ir, store);
    assert.deepEqual(schema.properties.format.enum, ['大卖场', '标超', '便利店']);
    assert.equal(schema.properties.format.type, 'string');
  });

  await it('money 导出为 number 并带说明', () => {
    const order = ir.objects.find((o) => o.id === 'Order');
    const schema = objectSchema(ir, order);
    assert.equal(schema.properties.amount.type, 'number');
    assert.ok(schema.properties.amount.description.includes('金额'));
  });

  await it('生成的 schema 能通过 JSON 往返', () => {
    const text = JSON.stringify(packageSchemas(ir));
    const parsed = JSON.parse(text);
    assert.ok(Object.keys(parsed.$defs).length === ir.objects.length);
    assert.equal(parsed.$defs.Inventory.title, '库存');
  });

  console.log('\npackageSchemas');

  await it('每个对象都在 $defs 里，包级元信息完整', () => {
    const bundle = packageSchemas(ir);
    assert.equal(bundle.$id, ir.id);
    assert.equal(bundle.version, ir.version);
    for (const object of ir.objects) {
      assert.ok(bundle.$defs[object.id], object.id + ' 缺失');
    }
  });

  console.log('\nmarkdownDoc');

  await it('包含对象、关系、规则、动作、策略五个部分', () => {
    const md = markdownDoc(ir);
    assert.ok(md.includes('# ' + ir.name));
    assert.ok(md.includes('## 对象'));
    assert.ok(md.includes('## 关系'));
    assert.ok(md.includes('## 规则'));
    assert.ok(md.includes('## 动作'));
    assert.ok(md.includes('## 策略'));
  });

  await it('动作标出可执行与审批，规则标出停用', () => {
    const md = markdownDoc(ir);
    assert.ok(md.includes('`adjustInventory`'));
    assert.ok(md.includes('需审批'));
    assert.ok(md.includes('已停用'), 'autoReplenish 是停用的，应标出来');
    assert.ok(md.includes('`createTransfer`'));
  });

  console.log('\n工具层');

  await it('ontology_export 导出两种格式且不写文件', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontology-export-'));
    fs.copyFileSync(ASSET, path.join(dir, 'store-inventory.ir.json'));
    const before = fs.readdirSync(dir).sort();

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
    const tool = registered.find((d) => d.name === 'ontology_export');
    assert.ok(tool, '应当注册 ontology_export');

    const schema = await tool.execute({ packageId: 'retail.store-inventory', objectId: 'Inventory' }, {});
    assert.equal(schema.ok, true);
    assert.equal(schema.format, 'json-schema');
    assert.doesNotThrow(() => JSON.parse(schema.content));

    const md = await tool.execute({ packageId: 'retail.store-inventory', format: 'markdown' }, {});
    assert.equal(md.ok, true);
    assert.ok(md.content.startsWith('# '));

    assert.deepEqual(fs.readdirSync(dir).sort(), before, '不得写入任何文件');
  });

  await it('未知对象与 markdown+objectId 都给出明确错误', async () => {
    const mod = await import('../index.js');
    const registered = [];
    mod.apply(
      {
        tools: { register: (d) => { registered.push(d); return () => {}; } },
        effect: (run) => run(),
        inject: () => () => {},
        get: () => undefined,
      },
      { assetsDir: path.join(ROOT, 'assets'), trace: false }
    );
    const tool = registered.find((d) => d.name === 'ontology_export');
    const ghost = await tool.execute({ packageId: 'retail.store-inventory', objectId: 'Ghost' }, {});
    assert.equal(ghost.ok, false);
    assert.ok(ghost.message.includes('Inventory'));

    const mixed = await tool.execute({ packageId: 'retail.store-inventory', format: 'markdown', objectId: 'Inventory' }, {});
    assert.equal(mixed.ok, false);
    assert.ok(mixed.message.includes('整包'));
  });

  const total = pass + failures.length;
  console.log(`\n${pass}/${total} passed`);
  if (failures.length) {
    for (const f of failures) console.error('\n' + f.name + '\n', f.error);
    process.exit(1);
  }
})();
