/**
 * 数据源同步的工具级集成测试：真的把 assets 目录指到临时目录，
 * 按 Host 的方式激活插件，然后调用工具本体。
 *
 * 覆盖四件事：
 *   1. 装包时写同步状态（什么时候读的、多少行）
 *   2. 源文件改了之后能说清变了什么
 *   3. applySchema 只加列不删属性，且要过审批
 *   4. render 不打印 undefined（签名写错 (v) 就会）
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

/** The smallest context the plugin accepts, with an approval service on demand. */
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

/** render 的返回值是 [{type:'text', text}]，拼起来看文案。 */
function rendered(def, args, value) {
  const chunks = def.output.render(args, value) || [];
  return chunks.map((c) => (c && c.text) || '').join('\n');
}

(async () => {
  const mod = await import('../index.js');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-sync-tool-'));
  const assetsDir = path.join(dir, 'assets');
  const csv = path.join(dir, 'stock.csv');
  fs.writeFileSync(csv, 'store_id,sku,on_hand\nS-0213,SKU-1001,80\nS-0188,SKU-1001,95\n');

  const { ctx, registered } = fakeContext({
    request: async () => 'allowed-once',
  });
  mod.apply(ctx, { assetsDir, trace: false, history: false });
  const byName = Object.fromEntries(registered.map((d) => [d.name, d]));

  console.log('\nsync tools');

  await it('ontology_package_from_csv 装包并写下首次同步状态', async () => {
    const value = await byName.ontology_package_from_csv.execute(
      { path: csv, packageId: 'demo.stock', domain: 'external' },
      EXEC
    );
    assert.equal(value.ok, true);
    assert.equal(value.rowCount, 2);
    assert.ok(value.syncedAt, '应回报同步时间');

    const irFile = path.join(assetsDir, 'demo.stock.ir.json');
    const syncFile = path.join(assetsDir, 'demo.stock.sync.json');
    assert.ok(fs.existsSync(irFile), '资产文件应落盘');
    assert.ok(fs.existsSync(syncFile), '同步状态应落盘');

    const state = JSON.parse(fs.readFileSync(syncFile, 'utf8'));
    assert.equal(state.rowCount, 2);
    assert.equal(state.runs, 1);
    assert.equal(state.changes.first, true);
    assert.equal(state.objectId, 'Stock');
  });

  await it('渲染出来的文案里没有 undefined（render 签名对不对）', async () => {
    const value = await byName.ontology_sync_status.execute({}, EXEC);
    const out = rendered(byName.ontology_sync_status, {}, value);
    assert.ok(!out.includes('undefined'), '渲染出现 undefined：' + out);
    assert.match(out, /demo\.stock/);
    assert.match(out, /首次接入于/);
  });

  await it('ontology_sync_status 报出数据源、行数、同步次数', async () => {
    const value = await byName.ontology_sync_status.execute({}, EXEC);
    assert.equal(value.ok, true);
    assert.equal(value.count, 1);
    assert.equal(value.entries[0].packageId, 'demo.stock');
    assert.equal(value.entries[0].rowCount, 2);
    assert.equal(value.entries[0].runs, 1);
    assert.match(value.entries[0].path, /stock\.csv$/);
  });

  await it('源文件加行加列后，ontology_sync_csv 说清变了什么', async () => {
    fs.writeFileSync(
      csv,
      'store_id,sku,on_hand,lead_time\nS-0213,SKU-1001,80,2\nS-0188,SKU-1001,95,3\nS-0300,SKU-2002,12,5\n'
    );
    const value = await byName.ontology_sync_csv.execute({ packageId: 'demo.stock' }, EXEC);
    assert.equal(value.ok, true);
    assert.equal(value.rowCount, 3);
    assert.equal(value.runs, 2);
    assert.deepEqual(value.added, ['lead_time']);
    assert.deepEqual(value.removed, []);
    assert.deepEqual(value.applied, [], '没要 applySchema 就不该动属性');
    assert.match(value.summary, /行数 \+1/);
    assert.match(value.summary, /新增列 lead_time/);

    const out = rendered(byName.ontology_sync_csv, {}, value);
    assert.ok(!out.includes('undefined'), '渲染出现 undefined：' + out);
  });

  await it('applySchema 把新增列补成属性，并留下 storage 映射', async () => {
    const value = await byName.ontology_sync_csv.execute(
      { packageId: 'demo.stock', applySchema: true },
      EXEC
    );
    assert.equal(value.ok, true);
    assert.deepEqual(value.applied, ['leadTime']);

    const ir = JSON.parse(fs.readFileSync(path.join(assetsDir, 'demo.stock.ir.json'), 'utf8'));
    const prop = ir.objects[0].properties.find((p) => p.name === 'leadTime');
    assert.ok(prop, 'leadTime 属性应存在');
    assert.equal(prop.storage, 'lead_time', 'storage 应指回源列');
    assert.equal(prop.type, 'integer');
    // 属性只加不删
    assert.equal(ir.objects[0].properties.length, 4);
  });

  await it('源文件里消失的列只报告，不删属性', async () => {
    fs.writeFileSync(csv, 'store_id,sku\nS-0213,SKU-1001\n');
    const value = await byName.ontology_sync_csv.execute({ packageId: 'demo.stock' }, EXEC);
    assert.equal(value.ok, true);
    assert.ok(value.removed.includes('on_hand'));
    assert.ok(value.removed.includes('lead_time'));
    const ir = JSON.parse(fs.readFileSync(path.join(assetsDir, 'demo.stock.ir.json'), 'utf8'));
    assert.equal(ir.objects[0].properties.length, 4, '属性不该被删掉');
  });

  await it('没有 CSV 来源的包不许瞎猜路径', async () => {
    fs.writeFileSync(
      path.join(assetsDir, 'manual.ir.json'),
      JSON.stringify(
        {
          irVersion: '1.0.0',
          id: 'manual',
          name: '手工包',
          version: '0.1.0',
          status: 'draft',
          objects: [{ id: 'Thing', name: '东西', keys: ['id'], properties: [{ name: 'id', type: 'string' }] }],
          links: [],
          rules: [],
          actions: [],
        },
        null,
        2
      )
    );
    const value = await byName.ontology_sync_csv.execute({ packageId: 'manual' }, EXEC);
    assert.equal(value.ok, false);
    assert.match(value.message, /没有记录过 CSV 来源/);
  });

  await it('审批被拒绝时 applySchema 什么也不写', async () => {
    const { ctx: ctx2, registered: reg2 } = fakeContext({ request: async () => 'rejected' });
    mod.apply(ctx2, { assetsDir, trace: false, history: false });
    const byName2 = Object.fromEntries(reg2.map((d) => [d.name, d]));
    const before = fs.readFileSync(path.join(assetsDir, 'demo.stock.ir.json'), 'utf8');

    const value = await byName2.ontology_sync_csv.execute(
      { packageId: 'demo.stock', applySchema: true, path: csv },
      EXEC
    );
    assert.equal(value.ok, false);
    assert.equal(value.blocked, true);
    assert.equal(value.approval, 'rejected');
    assert.equal(fs.readFileSync(path.join(assetsDir, 'demo.stock.ir.json'), 'utf8'), before);
  });

  await it('不带 applySchema 的同步不需要审批（非破坏性）', async () => {
    const { ctx: ctx3, registered: reg3 } = fakeContext({ request: async () => 'rejected' });
    mod.apply(ctx3, { assetsDir, trace: false, history: false });
    const byName3 = Object.fromEntries(reg3.map((d) => [d.name, d]));
    const value = await byName3.ontology_sync_csv.execute({ packageId: 'demo.stock', path: csv }, EXEC);
    assert.equal(value.ok, true, '非破坏性同步不该被审批挡住');
  });

  fs.rmSync(dir, { recursive: true, force: true });

  if (failures.length) {
    console.error('\n' + failures.length + ' failed');
    process.exit(1);
  }
  console.log('\n' + pass + '/' + pass + ' passed');
})().catch((err) => {
  console.error('FAIL', err && err.stack);
  process.exit(1);
});
