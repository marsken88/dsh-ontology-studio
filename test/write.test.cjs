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

function fakeContext(approval) {
  const registered = [];
  return {
    registered,
    approvalCalls: [],
    ctx: {
      tools: {
        register: (definition) => {
          registered.push(definition);
          return () => {};
        },
      },
      effect: (run) => run(),
      inject: () => () => {},
      get: (name) => (name === 'approval' ? approval : undefined),
    },
  };
}

async function loadTools(dir, options = {}) {
  const mod = await import('../index.js');
  const { ctx, registered } = fakeContext(options.approval);
  const config = Object.assign({ assetsDir: dir, approval: 'never' }, options.config || {});
  delete config.approval_stub;
  mod.apply(ctx, config);
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

  await it('dryRun 的渲染不出现 undefined（真机首跑踩过）', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir);
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
    const rendered = tools.ontology_upsert_object.output.render({}, result)[0].text;
    assert.ok(!rendered.includes('undefined'), '渲染里不能出现 undefined：' + rendered);
    assert.ok(rendered.includes('retail.store-inventory'), '应当带上资产包 id：' + rendered);
    assert.ok(rendered.includes('dryRun'), '应当说明未写盘：' + rendered);
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

  console.log('\nontology_upsert_link');

  await it('新增关系后落盘并通过校验', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir);
    const link = { id: 'order_belongs_to_store', source: 'Order', target: 'Store', type: 'placedAt', cardinality: 'n:1' };
    const result = await tools.ontology_upsert_link.execute({ packageId: 'retail.store-inventory', link }, {});
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.equal(result.action, 'created');
    const saved = readPackage(dir);
    assert.equal(saved.links.length, 6);
    const validated = await tools.ontology_validate.execute({}, {});
    assert.equal(validated.ok, true, JSON.stringify(validated.problems));
  });

  await it('关系端点不存在时拒绝且磁盘不变', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir);
    const beforeText = fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8');
    const result = await tools.ontology_upsert_link.execute(
      { packageId: 'retail.store-inventory', link: { id: 'bad_link', source: 'Ghost', target: 'Store', type: 'x' } },
      {}
    );
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.code === 'dangling-endpoint'), JSON.stringify(result.problems));
    assert.equal(fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8'), beforeText);
  });

  await it('替换已有关系（updated）', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir);
    const before = readPackage(dir);
    const link = JSON.parse(JSON.stringify(before.links[0]));
    link.cardinality = '1:1';
    const result = await tools.ontology_upsert_link.execute({ packageId: 'retail.store-inventory', link }, {});
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.equal(result.action, 'updated');
    const after = readPackage(dir);
    assert.equal(after.links.length, before.links.length);
    assert.equal(after.links.find((l) => l.id === link.id).cardinality, '1:1');
  });

  console.log('\nontology_delete_link');

  await it('删除关系后落盘并通过校验', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir);
    const result = await tools.ontology_delete_link.execute(
      { packageId: 'retail.store-inventory', linkId: 'member_shops_at_store' },
      {}
    );
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    const saved = readPackage(dir);
    assert.equal(saved.links.length, 4);
    assert.ok(!saved.links.some((l) => l.id === 'member_shops_at_store'));
    const validated = await tools.ontology_validate.execute({}, {});
    assert.equal(validated.ok, true);
  });

  await it('关系不存在时报错并列出可用关系', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir);
    const result = await tools.ontology_delete_link.execute(
      { packageId: 'retail.store-inventory', linkId: 'ghost_link' },
      {}
    );
    assert.equal(result.ok, false);
    assert.ok(result.message.includes('inventory_belongs_to_store'));
  });

  console.log('\nontology_delete_object');

  await it('对象仍被引用时默认拒绝，并列出全部依赖', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir);
    const beforeText = fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8');
    const result = await tools.ontology_delete_object.execute(
      { packageId: 'retail.store-inventory', objectId: 'Inventory' },
      {}
    );
    assert.equal(result.ok, false);
    assert.equal(result.blocked, true);
    assert.equal(result.links.length, 2);
    assert.equal(result.actions.length, 3);
    assert.ok(result.policies.length >= 1);
    assert.equal(fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8'), beforeText, '拒绝时不得写盘');
    const rendered = tools.ontology_delete_object.output.render({}, result);
    assert.ok(rendered[0].text.includes('cascade: true'));
  });

  await it('cascade 删除对象并连带清理关系、动作、策略', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir);
    const before = readPackage(dir);
    const result = await tools.ontology_delete_object.execute(
      { packageId: 'retail.store-inventory', objectId: 'Inventory', cascade: true },
      {}
    );
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.equal(result.cascaded.links, 2);
    const saved = readPackage(dir);
    assert.equal(saved.objects.length, before.objects.length - 1);
    assert.ok(!saved.objects.some((o) => o.id === 'Inventory'));
    assert.equal(saved.links.length, before.links.length - 2);
    assert.ok(!saved.links.some((l) => l.source === 'Inventory' || l.target === 'Inventory'));
    // adjustInventory / startStocktake 只写 Inventory → 一并删除；createTransfer 还写 Order → 保留
    assert.ok(!saved.actions.some((a) => a.id === 'adjustInventory'));
    assert.ok(!saved.actions.some((a) => a.id === 'startStocktake'));
    const transfer = saved.actions.find((a) => a.id === 'createTransfer');
    assert.deepEqual(transfer.writes, ['Order']);
    // 指向被删动作的策略被修剪，不留悬空引用
    for (const policy of saved.policies) {
      for (const target of policy.appliesTo || []) {
        assert.ok(saved.actions.some((a) => a.id === target), `策略 ${policy.id} 悬空指向 ${target}`);
      }
    }
    const validated = await tools.ontology_validate.execute({}, {});
    assert.equal(validated.ok, true, JSON.stringify(validated.problems));
    // Agent 花名册里对 Inventory 的引用也应被摘掉，否则整包会失效
    assert.ok(!saved.agents.some((a) => (a.usesObjects || []).includes('Inventory')), 'agent 仍引用已删除对象');
  });

  await it('cascade + dryRun 只预览不落盘', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir);
    const beforeText = fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8');
    const result = await tools.ontology_delete_object.execute(
      { packageId: 'retail.store-inventory', objectId: 'Inventory', cascade: true, dryRun: true },
      {}
    );
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8'), beforeText);
  });

  await it('未被引用的对象可直接删除', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir);
    // 先加一个孤立的对象，再删掉
    await tools.ontology_upsert_object.execute(
      {
        packageId: 'retail.store-inventory',
        object: { id: 'Warehouse', name: '仓库', keys: ['warehouseId'], properties: [{ name: 'warehouseId', type: 'string', required: true }] },
      },
      {}
    );
    const result = await tools.ontology_delete_object.execute(
      { packageId: 'retail.store-inventory', objectId: 'Warehouse' },
      {}
    );
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.equal(result.blocked, undefined);
    const saved = readPackage(dir);
    assert.ok(!saved.objects.some((o) => o.id === 'Warehouse'));
    assert.equal(saved.objects.length, 6);
  });

  await it('对象不存在时报错并列出可用对象', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir);
    const result = await tools.ontology_delete_object.execute(
      { packageId: 'retail.store-inventory', objectId: 'Ghost' },
      {}
    );
    assert.equal(result.ok, false);
    assert.ok(result.message.includes('Inventory'));
  });

  console.log('\n审批闸门');

  const AGENT = { id: 'session-1' };

  await it('默认 destructive 模式下删除需要审批，无审批服务则拒绝', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir, { config: { approval: 'destructive' } });
    const beforeText = fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8');
    const result = await tools.ontology_delete_link.execute(
      { packageId: 'retail.store-inventory', linkId: 'member_shops_at_store' },
      { agent: AGENT }
    );
    assert.equal(result.ok, false);
    assert.equal(result.approval, 'unavailable');
    assert.ok(result.message.includes('审批服务不可用'));
    assert.equal(fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8'), beforeText);
  });

  await it('审批被拒绝时什么也不写', async () => {
    const dir = tempAssets();
    let asked = null;
    const tools = await loadTools(dir, {
      approval: {
        request: async (req) => {
          asked = req;
          return 'rejected';
        },
      },
      config: { approval: 'destructive' },
    });
    const beforeText = fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8');
    const result = await tools.ontology_delete_object.execute(
      { packageId: 'retail.store-inventory', objectId: 'Inventory', cascade: true },
      { agent: AGENT, callId: 'call-1' }
    );
    assert.equal(result.ok, false);
    assert.equal(result.approval, 'rejected');
    assert.ok(asked, '应当发起审批请求');
    assert.equal(asked.toolName, 'ontology_delete_object');
    assert.equal(asked.callId, 'call-1');
    assert.ok(asked.reason.includes('Inventory'));
    assert.equal(fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8'), beforeText);
  });

  await it("只有 'allowed-once' 放行，且放行后照常写入", async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir, {
      approval: { request: async () => 'allowed-once' },
      config: { approval: 'destructive' },
    });
    const result = await tools.ontology_delete_link.execute(
      { packageId: 'retail.store-inventory', linkId: 'member_shops_at_store' },
      { agent: AGENT }
    );
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    const saved = readPackage(dir);
    assert.equal(saved.links.length, 4);
  });

  await it("其余 outcome（cancelled / unavailable）一律失败关闭", async () => {
    for (const outcome of ['cancelled', 'unavailable', 'whatever']) {
      const dir = tempAssets();
      const tools = await loadTools(dir, {
        approval: { request: async () => outcome },
        config: { approval: 'destructive' },
      });
      const result = await tools.ontology_publish.execute(
        { packageId: 'retail.store-inventory' },
        { agent: AGENT }
      );
      assert.equal(result.ok, false, outcome + ' 不应放行');
      assert.equal(result.approval, outcome);
    }
  });

  await it('审批服务抛错时按失败关闭处理', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir, {
      approval: {
        request: async () => {
          throw new Error('no open turn');
        },
      },
      config: { approval: 'destructive' },
    });
    const result = await tools.ontology_publish.execute({ packageId: 'retail.store-inventory' }, { agent: AGENT });
    assert.equal(result.ok, false);
    assert.equal(result.approval, 'unavailable');
    assert.ok(result.message.includes('no open turn'));
  });

  await it('destructive 模式下非破坏性写入不打扰用户', async () => {
    const dir = tempAssets();
    let calls = 0;
    const tools = await loadTools(dir, {
      approval: {
        request: async () => {
          calls += 1;
          return 'rejected';
        },
      },
      config: { approval: 'destructive' },
    });
    const result = await tools.ontology_upsert_object.execute(
      {
        packageId: 'retail.store-inventory',
        object: {
          id: 'Warehouse',
          name: '仓库',
          keys: ['warehouseId'],
          properties: [{ name: 'warehouseId', type: 'string', required: true }],
        },
      },
      { agent: AGENT }
    );
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.equal(calls, 0, '新增对象不应触发审批');
  });

  await it("approval: 'all' 时连新增对象也要审批", async () => {
    const dir = tempAssets();
    let calls = 0;
    const tools = await loadTools(dir, {
      approval: {
        request: async () => {
          calls += 1;
          return 'rejected';
        },
      },
      config: { approval: 'all' },
    });
    const result = await tools.ontology_upsert_object.execute(
      {
        packageId: 'retail.store-inventory',
        object: {
          id: 'Warehouse',
          name: '仓库',
          keys: ['warehouseId'],
          properties: [{ name: 'warehouseId', type: 'string', required: true }],
        },
      },
      { agent: AGENT }
    );
    assert.equal(calls, 1);
    assert.equal(result.ok, false);
    assert.equal(result.approval, 'rejected');
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
