/**
 * 视图的工具级集成：真的把 assets 指向临时目录，按 Host 的方式激活插件。
 *
 * 走的是一条完整链路：
 *   声明视图 → 整包校验 → ontology_get 带 view 裁剪 → ontology_export 按视图导出
 *   → 视图写错被拒 → 删除视图
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
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

function fakeContext(approval) {
  const registered = [];
  return {
    registered,
    ctx: {
      tools: {
        register(definition) {
          registered.push(definition);
          return () => {};
        },
      },
      effect(run) {
        return run();
      },
      inject() {
        return () => {};
      },
      on() {},
      off() {},
      get(name) {
        return name === 'approval' ? approval : undefined;
      },
    },
  };
}

const EXEC = { agent: { id: 'test-agent' }, callId: 'call-1' };

(async () => {
  const mod = await import('../index.js');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-views-'));
  const assetsDir = path.join(dir, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, 'assets', 'store-inventory.ir.json'),
    path.join(assetsDir, 'store-inventory.ir.json')
  );

  const { ctx, registered } = fakeContext({ request: async () => 'allowed-once' });
  mod.apply(ctx, { assetsDir, trace: false, history: false });
  const byName = Object.fromEntries(registered.map((d) => [d.name, d]));

  const PKG = 'retail.store-inventory';
  const view = {
    id: 'store-manager',
    name: '门店店长视角',
    description: '只看库存与商品，不暴露成本',
    objects: [
      { objectId: 'Inventory', properties: ['storeId', 'skuId', 'availableQty', 'safetyStock'] },
      { objectId: 'Product', properties: ['productId', 'productName'] },
    ],
  };

  console.log('\n视图工具');

  await it('ontology_upsert_view 新增视图并报出覆盖情况', async () => {
    const value = await byName.ontology_upsert_view.execute({ packageId: PKG, view }, EXEC);
    assert.equal(value.ok, true);
    assert.equal(value.action, 'created');
    assert.equal(value.viewId, 'store-manager');
    const inventory = (value.coverage || []).find((c) => c.objectId === 'Inventory');
    assert.equal(inventory.covered.length, 4);
    assert.equal(inventory.total, 8);
    assert.ok(inventory.uncovered.includes('onHandQty'));
    assert.match(value.summary, /2 个对象/);
  });

  await it('写进磁盘的视图能被重新读出来', async () => {
    const ir = JSON.parse(fs.readFileSync(path.join(assetsDir, 'store-inventory.ir.json'), 'utf8'));
    assert.equal((ir.views || []).length, 1);
    assert.equal(ir.views[0].id, 'store-manager');
  });

  await it('再声明一次是更新，不是又加一个', async () => {
    const value = await byName.ontology_upsert_view.execute(
      { packageId: PKG, view: Object.assign({}, view, { name: '店长视角 v2' }) },
      EXEC
    );
    assert.equal(value.action, 'updated');
    const ir = JSON.parse(fs.readFileSync(path.join(assetsDir, 'store-inventory.ir.json'), 'utf8'));
    assert.equal(ir.views.length, 1);
    assert.equal(ir.views[0].name, '店长视角 v2');
  });

  await it('视图里写了不存在的属性：拒绝，且磁盘不动', async () => {
    const before = fs.readFileSync(path.join(assetsDir, 'store-inventory.ir.json'), 'utf8');
    const value = await byName.ontology_upsert_view.execute(
      {
        packageId: PKG,
        view: { id: 'typo', name: '写错了', objects: [{ objectId: 'Inventory', properties: ['costPrice'] }] },
      },
      EXEC
    );
    assert.equal(value.ok, false);
    assert.match(value.message, /没有通过整包校验/);
    assert.ok((value.problems || []).some((p) => p.code === 'dangling-property'));
    assert.equal(fs.readFileSync(path.join(assetsDir, 'store-inventory.ir.json'), 'utf8'), before);
  });

  await it('ontology_get 带 view：只返回视图内的对象与属性', async () => {
    const value = await byName.ontology_get.execute({ packageId: PKG, view: 'store-manager' }, EXEC);
    assert.equal(value.found, true);
    assert.deepEqual(value.objects.map((o) => o.id).sort(), ['Inventory', 'Product']);
    assert.equal(value.view.id, 'store-manager');
    assert.ok(value.hidden.objects.includes('Supplier'));
    assert.ok(value.hidden.properties.length > 0);
    assert.equal(value.package.objects, 2, '摘要也应是裁剪后的');
  });

  await it('ontology_get 带 view 取单个对象：属性只剩视图内的', async () => {
    const value = await byName.ontology_get.execute(
      { packageId: PKG, objectId: 'Inventory', view: 'store-manager' },
      EXEC
    );
    assert.equal(value.found, true);
    assert.deepEqual(
      value.object.properties.map((p) => p.name),
      ['storeId', 'skuId', 'availableQty', 'safetyStock']
    );
    assert.ok(value.hidden, '要说明裁掉了什么');
  });

  await it('视图外的对象：明确说「不在视图内」而不是「不存在」', async () => {
    const value = await byName.ontology_get.execute(
      { packageId: PKG, objectId: 'Supplier', view: 'store-manager' },
      EXEC
    );
    assert.equal(value.found, false);
    assert.match(value.problems[0].message, /不在视图/);
  });

  await it('视图不存在：报错并列出可用视图', async () => {
    const value = await byName.ontology_get.execute({ packageId: PKG, view: 'nope' }, EXEC);
    assert.equal(value.found, false);
    assert.match(value.problems[0].message, /视图不存在/);
    assert.deepEqual(value.available, ['store-manager']);
  });

  await it('ontology_export 按视图导出 json-schema，只含视图字段', async () => {
    const value = await byName.ontology_export.execute(
      { packageId: PKG, format: 'json-schema', view: 'store-manager', objectId: 'Inventory' },
      EXEC
    );
    assert.equal(value.ok, true);
    const schema = JSON.parse(value.content);
    assert.deepEqual(Object.keys(schema.properties).sort(), [
      'availableQty',
      'safetyStock',
      'skuId',
      'storeId',
    ]);
  });

  await it('ontology_export 按视图导出 markdown，看不见的对象不出现', async () => {
    const value = await byName.ontology_export.execute(
      { packageId: PKG, format: 'markdown', view: 'store-manager' },
      EXEC
    );
    assert.equal(value.ok, true);
    assert.ok(value.content.includes('Inventory'));
    assert.ok(!value.content.includes('Supplier'), '不可见对象不该出现在文档里');
  });

  await it('ontology_delete_view 删掉视图后按它读取会明确报错', async () => {
    const value = await byName.ontology_delete_view.execute({ packageId: PKG, viewId: 'store-manager' }, EXEC);
    assert.equal(value.ok, true);
    assert.deepEqual(value.remaining, []);
    const got = await byName.ontology_get.execute({ packageId: PKG, view: 'store-manager' }, EXEC);
    assert.equal(got.found, false);
    assert.match(got.problems[0].message, /视图不存在/);
  });

  await it('删除不存在的视图：拒绝并列出剩下的', async () => {
    const value = await byName.ontology_delete_view.execute({ packageId: PKG, viewId: 'ghost' }, EXEC);
    assert.equal(value.ok, false);
    assert.match(value.message, /视图不存在/);
  });

  await it('审批档位 all：视图声明被拒绝时不落盘', async () => {
    const { ctx: ctx2, registered: reg2 } = fakeContext({ request: async () => 'rejected' });
    mod.apply(ctx2, { assetsDir, trace: false, history: false, approval: 'all' });
    const byName2 = Object.fromEntries(reg2.map((d) => [d.name, d]));
    const before = fs.readFileSync(path.join(assetsDir, 'store-inventory.ir.json'), 'utf8');
    const value = await byName2.ontology_upsert_view.execute({ packageId: PKG, view }, EXEC);
    assert.equal(value.ok, false);
    assert.equal(value.blocked, true);
    assert.equal(value.approval, 'rejected');
    assert.equal(fs.readFileSync(path.join(assetsDir, 'store-inventory.ir.json'), 'utf8'), before);
  });

  await it('默认档位（destructive）下视图声明不需要审批——和改对象同一层级', async () => {
    const { ctx: ctx3, registered: reg3 } = fakeContext({
      request: async () => {
        throw new Error('不该被问到');
      },
    });
    mod.apply(ctx3, { assetsDir, trace: false, history: false });
    const byName3 = Object.fromEntries(reg3.map((d) => [d.name, d]));
    const value = await byName3.ontology_upsert_view.execute({ packageId: PKG, view }, EXEC);
    assert.equal(value.ok, true);
  });

  fs.rmSync(dir, { recursive: true, force: true });

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
