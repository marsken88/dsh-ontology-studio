/**
 * Concurrency tests: optimistic locking (etag compare-and-swap) and the
 * per-file write lock. A lost update must fail loudly, never silently.
 * Run `node test/concurrency.test.cjs`.
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

function tempAssets() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontology-conc-'));
  fs.copyFileSync(ASSET, path.join(dir, 'store-inventory.ir.json'));
  fs.copyFileSync(RECORDS, path.join(dir, 'store-inventory.records.json'));
  return dir;
}

function fakeContext() {
  const registered = [];
  return {
    ctx: {
      tools: { register: (d) => { registered.push(d); return () => {}; } },
      effect: (run) => run(),
      inject: () => () => {},
      get: () => undefined,
    },
    registered,
  };
}

async function loadTools(dir, options = {}) {
  const mod = await import('../index.js');
  const { ctx, registered } = fakeContext();
  mod.apply(ctx, Object.assign({ assetsDir: dir, approval: 'never', trace: false }, options));
  return Object.fromEntries(registered.map((d) => [d.name, d]));
}

const readIr = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8'));

function newObject(id) {
  return {
    id,
    name: id,
    keys: ['k'],
    properties: [{ name: 'k', type: 'string', required: true }],
  };
}

(async () => {
  const { createStore, etagOf } = await import('../lib/store.mjs');

  console.log('\netag');

  await it('同样的内容给同样的 etag，内容变了 etag 就变', () => {
    assert.equal(etagOf('a'), etagOf('a'));
    assert.notEqual(etagOf('a'), etagOf('b'));
    assert.ok(/^sha256-[0-9a-f]{16}$/.test(etagOf('x')));
  });

  await it('store.get 返回当前 etag', async () => {
    const dir = tempAssets();
    const store = createStore({ dir });
    const { entry } = await store.get('retail.store-inventory');
    assert.ok(entry.etag);
    assert.equal(entry.etag, etagOf(fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8')));
  });

  console.log('\n乐观锁（store.save）');

  await it('etag 匹配时写入成功并返回新 etag', async () => {
    const dir = tempAssets();
    const store = createStore({ dir });
    const { entry } = await store.get('retail.store-inventory');
    const ir = JSON.parse(JSON.stringify(entry.ir));
    ir.description = '改一下';
    const saved = await store.save(entry.file, ir, { ifEtag: entry.etag });
    assert.equal(saved.ok, true);
    assert.notEqual(saved.etag, entry.etag, '内容变了 etag 应当变');
  });

  await it('etag 过期时拒绝写入并返回当前 etag', async () => {
    const dir = tempAssets();
    const store = createStore({ dir });
    const { entry } = await store.get('retail.store-inventory');
    const stale = entry.etag;
    // 别人先改了一次
    const first = JSON.parse(JSON.stringify(entry.ir));
    first.description = '别人改的';
    await store.save(entry.file, first, { ifEtag: stale });

    const mine = JSON.parse(JSON.stringify(entry.ir));
    mine.description = '我改的';
    const conflict = await store.save(entry.file, mine, { ifEtag: stale });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.conflict, true);
    assert.notEqual(conflict.etag, stale);
    assert.equal(readIr(dir).description, '别人改的', '我的写入不得生效');
  });

  await it('不带 ifEtag 时仍然直接写（向后兼容）', async () => {
    const dir = tempAssets();
    const store = createStore({ dir });
    const { entry } = await store.get('retail.store-inventory');
    const ir = JSON.parse(JSON.stringify(entry.ir));
    ir.description = 'no-cas';
    const saved = await store.save(entry.file, ir);
    assert.equal(saved.ok, true);
    assert.equal(readIr(dir).description, 'no-cas');
  });

  await it('写锁保证并发写不会写出半截 JSON', async () => {
    const dir = tempAssets();
    const store = createStore({ dir });
    const { entry } = await store.get('retail.store-inventory');
    const variants = ['a', 'b', 'c', 'd', 'e'].map((tag) => {
      const ir = JSON.parse(JSON.stringify(entry.ir));
      ir.description = tag;
      return ir;
    });
    await Promise.all(variants.map((ir) => store.save(entry.file, ir)));
    const text = fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8');
    assert.doesNotThrow(() => JSON.parse(text), '文件必须是完整 JSON');
    assert.ok(['a', 'b', 'c', 'd', 'e'].includes(JSON.parse(text).description));
  });

  console.log('\n工具层：并发写入必须有人失败');

  await it('五路并发新增对象：全部成功，一个都不丢', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir);
    const ids = ['W1', 'W2', 'W3', 'W4', 'W5'];
    const results = await Promise.all(
      ids.map((id) => tools.ontology_upsert_object.execute({ packageId: 'retail.store-inventory', object: newObject(id) }, {}))
    );
    // 新增对象是可串行化操作：读-改-写整体在文件锁内完成，所以并发不是争抢
    // 而是排队。旧实现只锁写入，导致五路里四路报冲突。
    assert.equal(results.filter((r) => r.ok).length, 5, JSON.stringify(results.filter((r) => !r.ok).map((r) => r.message)));

    const saved = readIr(dir);
    const added = saved.objects.filter((o) => ids.includes(o.id));
    assert.equal(added.length, 5, '五个对象必须都在，丢一个就是 lost update');
    assert.equal(saved.objects.length, 11, '6 个原有 + 5 个新增');
  });

  await it('显式 ifEtag 仍然优先：拿着旧 etag 写会被拒绝', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir);
    const first = await tools.ontology_upsert_object.execute(
      { packageId: 'retail.store-inventory', object: newObject('W1') },
      {}
    );
    assert.equal(first.ok, true);
    const stale = first.etag;

    // 再写一次，然后拿已经过期的 etag 试图覆盖
    await tools.ontology_upsert_object.execute({ packageId: 'retail.store-inventory', object: newObject('W2') }, {});
    const rejected = await tools.ontology_upsert_object.execute(
      { packageId: 'retail.store-inventory', object: newObject('W9'), ifEtag: stale },
      {}
    );
    assert.equal(rejected.ok, false);
    assert.equal(rejected.conflict, true);
    assert.ok(rejected.message.includes('重新读取'));
    assert.ok(!readIr(dir).objects.some((o) => o.id === 'W9'), '冲突时不得写入');

    // 用返回的最新 etag 重试即可成功
    const retry = await tools.ontology_upsert_object.execute(
      { packageId: 'retail.store-inventory', object: newObject('W9'), ifEtag: rejected.etag },
      {}
    );
    assert.equal(retry.ok, true, JSON.stringify(retry.problems));
    assert.ok(readIr(dir).objects.some((o) => o.id === 'W9'));
  });
  await it('顺序写入（每次都重新读取）不受影响', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir);
    for (const id of ['S1', 'S2', 'S3']) {
      const result = await tools.ontology_upsert_object.execute(
        { packageId: 'retail.store-inventory', object: newObject(id) },
        {}
      );
      assert.equal(result.ok, true, id + ' 应当成功：' + JSON.stringify(result.problems));
    }
    assert.equal(readIr(dir).objects.length, 9);
  });

  await it('执行动作复用同一套 CAS：并发调整同一行只有一笔生效', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir);
    const results = await Promise.all(
      [300, 400, 500].map((qty) =>
        tools.ontology_execute_action.execute(
          {
            packageId: 'retail.store-inventory',
            actionId: 'adjustInventory',
            input: { storeId: 'S-0213', skuId: 'SKU-1001', availableQty: qty },
          },
          {}
        )
      )
    );
    assert.equal(results.filter((r) => r.ok).length, 1, '并发执行动作应当只有一笔成功');
    assert.ok(results.filter((r) => !r.ok).every((r) => r.conflict === true));
    const records = JSON.parse(fs.readFileSync(path.join(dir, 'store-inventory.records.json'), 'utf8'));
    const row = records.objects.Inventory.find((r) => r.storeId === 'S-0213' && r.skuId === 'SKU-1001');
    assert.ok([300, 400, 500].includes(row.availableQty), '最终值应当是某一笔的真实结果，不是混乱的中间态');
  });

  const total = pass + failures.length;
  console.log(`\n${pass}/${total} passed`);
  if (failures.length) {
    for (const f of failures) console.error('\n' + f.name + '\n', f.error);
    process.exit(1);
  }
})();
