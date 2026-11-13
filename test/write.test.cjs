/**
 * Write-path tests. Every case runs against a throwaway directory copy of the
 * shipped asset, so the repository's own assets are never touched.
 * Run `node test/write.test.cjs`.
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

function tempAssets() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontology-write-'));
  fs.copyFileSync(ASSET, path.join(dir, 'store-inventory.ir.json'));
  return dir;
}

function fakeContext() {
  const registered = [];
  return {
    registered,
    ctx: {
      tools: {
        register: (definition) => {
          registered.push(definition);
          return () => {};
        },
      },
      effect: (run) => run(),
      inject: () => () => {},
    },
  };
}

async function loadTools(dir) {
  const mod = await import('../index.js');
  const { ctx, registered } = fakeContext();
  mod.apply(ctx, { assetsDir: dir });
  return Object.fromEntries(registered.map((d) => [d.name, d]));
}

function readPackage(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8'));
}

(async () => {
  const { bumpVersion } = await import('../lib/store.mjs');

  console.log('\nbumpVersion');

  await it('patch / minor / major 递增正确', () => {
    assert.equal(bumpVersion('1.0.0', 'patch'), '1.0.1');
    assert.equal(bumpVersion('1.0.0', 'minor'), '1.1.0');
    assert.equal(bumpVersion('1.0.0', 'major'), '2.0.0');
    assert.equal(bumpVersion('1.0.0'), '1.0.1', '默认 patch');
    assert.equal(bumpVersion('9.9.9', 'major'), '10.0.0');
  });

  console.log('\nontology_upsert_object');

  await it('新增对象后落盘并可通过校验', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir);
    const object = {
      id: 'Warehouse',
      name: '仓库',
      description: '区域仓，负责门店补货的干线库存。',
      keys: ['warehouseId'],
      properties: [
        { name: 'warehouseId', label: '仓库编号', type: 'string', required: true },
        { name: 'capacity', label: '容量', type: 'number' },
      ],
    };
    const result = await tools.ontology_upsert_object.execute(
      { packageId: 'retail.store-inventory', object },
      {}
    );
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.equal(result.action, 'created');
    assert.equal(result.objectId, 'Warehouse');
    const saved = readPackage(dir);
    assert.equal(saved.objects.length, 7);
    assert.ok(saved.objects.some((o) => o.id === 'Warehouse'));
    const validated = await tools.ontology_validate.execute({}, {});
    assert.equal(validated.ok, true, JSON.stringify(validated.problems));
  });

  await it('替换已有对象（updated）', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir);
    const before = readPackage(dir);
    const inventory = before.objects.find((o) => o.id === 'Inventory');
    const next = JSON.parse(JSON.stringify(inventory));
    next.properties.push({ name: 'inTransitQty', label: '在途数量', type: 'number' });
    const result = await tools.ontology_upsert_object.execute(
      { packageId: 'retail.store-inventory', object: next },
      {}
    );
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.equal(result.action, 'updated');
    const after = readPackage(dir);
    assert.equal(after.objects.length, before.objects.length, '更新不应新增对象');
    const saved = after.objects.find((o) => o.id === 'Inventory');
    assert.ok(saved.properties.some((p) => p.name === 'inTransitQty'));
  });

  await it('无效对象被拒绝且磁盘不变', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir);
    const beforeText = fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8');
    const result = await tools.ontology_upsert_object.execute(
      {
        packageId: 'retail.store-inventory',
        object: { id: 'locker', name: '柜子', properties: [{ name: 'x', type: 'string' }] },
      },
      {}
    );
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.code === 'bad-id'), JSON.stringify(result.problems));
    const afterText = fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8');
    assert.equal(afterText, beforeText, '校验失败必须保持磁盘原样');
  });

  await it('写入会让主键悬空时被拒绝', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir);
    const beforeText = fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8');
    const result = await tools.ontology_upsert_object.execute(
      {
        packageId: 'retail.store-inventory',
        object: {
          id: 'Warehouse',
          name: '仓库',
          keys: ['ghostProp'],
          properties: [{ name: 'warehouseId', type: 'string' }],
        },
      },
      {}
    );
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.code === 'dangling-key'), JSON.stringify(result.problems));
    assert.equal(fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8'), beforeText);
  });

  await it('改对象 id 是新增而不是重命名（不会静默断开关系）', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir);
    const before = readPackage(dir);
    const store = before.objects.find((o) => o.id === 'Store');
    const renamed = JSON.parse(JSON.stringify(store));
    renamed.id = 'Shop';
    const result = await tools.ontology_upsert_object.execute(
      { packageId: 'retail.store-inventory', object: renamed },
      {}
    );
    assert.equal(result.ok, true);
    assert.equal(result.action, 'created');
    const after = readPackage(dir);
    assert.ok(after.objects.some((o) => o.id === 'Store'), '原对象仍在');
    assert.ok(after.objects.some((o) => o.id === 'Shop'), '新对象已加入');
    const validated = await tools.ontology_validate.execute({}, {});
    assert.equal(validated.ok, true, '关系仍然指向 Store，没有断链');
  });

  await it('dryRun 通过校验但不落盘', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir);
    const beforeText = fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8');
    const result = await tools.ontology_upsert_object.execute(
      {
        packageId: 'retail.store-inventory',
        object: {
          id: 'Warehouse',
          name: '仓库',
          keys: ['warehouseId'],
          properties: [{ name: 'warehouseId', type: 'string', required: true }],
        },
        dryRun: true,
      },
      {}
    );
    assert.equal(result.ok, true);
    const afterText = fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8');
    assert.equal(afterText, beforeText);
  });

  await it('不存在的包直接报错', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir);
    const result = await tools.ontology_upsert_object.execute(
      { packageId: 'nope', object: { id: 'X', name: 'X', properties: [{ name: 'a', type: 'string' }] } },
      {}
    );
    assert.equal(result.ok, false);
    assert.ok(result.message.includes('nope'));
  });

  console.log('\nontology_publish');

  await it('发布递增版本并置为 published', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir);
    const result = await tools.ontology_publish.execute({ packageId: 'retail.store-inventory' }, {});
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.equal(result.from, '1.0.0');
    assert.equal(result.to, '1.0.1');
    const saved = readPackage(dir);
    assert.equal(saved.version, '1.0.1');
    assert.equal(saved.status, 'published');
  });

  await it('minor / major 递增生效', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir);
    const minor = await tools.ontology_publish.execute({ packageId: 'retail.store-inventory', bump: 'minor' }, {});
    assert.equal(minor.to, '1.1.0');
    const major = await tools.ontology_publish.execute({ packageId: 'retail.store-inventory', bump: 'major' }, {});
    assert.equal(major.to, '2.0.0');
  });

  await it('包无效时拒绝发布且磁盘不变', async () => {
    const dir = tempAssets();
    const ir = readPackage(dir);
    ir.links[0].target = 'Ghost';
    fs.writeFileSync(path.join(dir, 'store-inventory.ir.json'), JSON.stringify(ir, null, 2));
    const beforeText = fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8');
    const tools = await loadTools(dir);
    const result = await tools.ontology_publish.execute({ packageId: 'retail.store-inventory' }, {});
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.code === 'dangling-endpoint'));
    const afterText = fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8');
    assert.equal(afterText, beforeText);
  });

  console.log('\nstore.save');

  await it('save 拒绝无效 IR 且 force 可覆盖', async () => {
    const dir = tempAssets();
    const { createStore } = await import('../lib/store.mjs');
    const store = createStore({ dir });
    const bad = { id: 'not-a-package', version: 'x' };
    const refused = await store.save('new.ir.json', bad);
    assert.equal(refused.ok, false);
    assert.ok(!fs.existsSync(path.join(dir, 'new.ir.json')));
    const forced = await store.save('new.ir.json', bad, { force: true });
    assert.equal(forced.ok, false, '仍应报告校验失败');
    assert.ok(fs.existsSync(path.join(dir, 'new.ir.json')), 'force 后文件应写盘');
  });

  const total = pass + failures.length;
  console.log(`\n${pass}/${total} passed`);
  if (failures.length) {
    for (const f of failures) console.error('\n' + f.name + '\n', f.error);
    process.exit(1);
  }
})();
