/**
 * Version-history tests: every mutation leaves a record, newest first.
 * Run `node test/history.test.cjs`.
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

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontology-hist-'));
  fs.copyFileSync(ASSET, path.join(dir, 'store-inventory.ir.json'));
  return dir;
}

async function loadTools(dir, options = {}) {
  const mod = await import('../index.js');
  const registered = [];
  const ctx = {
    tools: { register: (d) => { registered.push(d); return () => {}; } },
    effect: (run) => run(),
    inject: () => () => {},
    get: () => undefined,
  };
  mod.apply(ctx, Object.assign({ assetsDir: dir, approval: 'never', trace: false }, options));
  return Object.fromEntries(registered.map((d) => [d.name, d]));
}

const newObject = (id) => ({
  id,
  name: id,
  keys: ['k'],
  properties: [{ name: 'k', type: 'string', required: true }],
});

(async () => {
  console.log('\n记录变更');

  await it('新增对象、发布、删除都会留下记录，且版本号跟着变', async () => {
    const dir = tempDir();
    const tools = await loadTools(dir, { historyFile: path.join(dir, 'h.jsonl') });

    await tools.ontology_upsert_object.execute({ packageId: 'retail.store-inventory', object: newObject('Warehouse') }, {});
    await tools.ontology_publish.execute({ packageId: 'retail.store-inventory', bump: 'minor' }, {});
    await tools.ontology_delete_object.execute({ packageId: 'retail.store-inventory', objectId: 'Warehouse' }, {});

    const result = await tools.ontology_history.execute({ packageId: 'retail.store-inventory' }, {});
    assert.equal(result.ok, true);
    assert.equal(result.entries.length, 3);

    const ops = result.entries.map((e) => e.op);
    assert.deepEqual(ops, ['delete_object', 'publish', 'upsert_object'], '应当新→旧排列');
    assert.equal(result.entries[0].version, '1.1.0', '删除发生在发布之后');
    assert.equal(result.entries[1].version, '1.1.0');
    assert.equal(result.entries[2].version, '1.0.0');
    assert.ok(result.entries[2].summary.includes('Warehouse'));
  });

  await it('关系的增删也有记录', async () => {
    const dir = tempDir();
    const tools = await loadTools(dir, { historyFile: path.join(dir, 'h.jsonl') });
    await tools.ontology_upsert_link.execute(
      { packageId: 'retail.store-inventory', link: { id: 'order_to_store', source: 'Order', target: 'Store', type: 'placedAt' } },
      {}
    );
    await tools.ontology_delete_link.execute({ packageId: 'retail.store-inventory', linkId: 'order_to_store' }, {});
    const result = await tools.ontology_history.execute({}, {});
    assert.deepEqual(result.entries.map((e) => e.op), ['delete_link', 'upsert_link']);
  });

  await it('被拒绝的写入不产生记录', async () => {
    const dir = tempDir();
    const tools = await loadTools(dir, { historyFile: path.join(dir, 'h.jsonl') });
    const bad = await tools.ontology_upsert_object.execute(
      { packageId: 'retail.store-inventory', object: { id: 'locker', name: 'x', properties: [{ name: 'a', type: 'string' }] } },
      {}
    );
    assert.equal(bad.ok, false);
    const result = await tools.ontology_history.execute({}, {});
    assert.equal(result.entries.length, 0, '失败的写入不应留痕');
  });

  console.log('\n查询');

  await it('过滤与条数上限', async () => {
    const dir = tempDir();
    const tools = await loadTools(dir, { historyFile: path.join(dir, 'h.jsonl') });
    for (const id of ['A1', 'A2', 'A3']) {
      await tools.ontology_upsert_object.execute({ packageId: 'retail.store-inventory', object: newObject(id) }, {});
    }
    const limited = await tools.ontology_history.execute({ limit: 2 }, {});
    assert.equal(limited.entries.length, 2);

    const other = await tools.ontology_history.execute({ packageId: 'nope' }, {});
    assert.equal(other.entries.length, 0, '别的包不应串味');
  });

  await it('没有历史时给出友好提示而不是空表', async () => {
    const dir = tempDir();
    const tools = await loadTools(dir, { historyFile: path.join(dir, 'h.jsonl') });
    const result = await tools.ontology_history.execute({}, {});
    const rendered = tools.ontology_history.output.render({}, result)[0].text;
    assert.ok(rendered.includes('还没有任何变更记录'));
  });

  await it('关闭历史则不记录', async () => {
    const dir = tempDir();
    const tools = await loadTools(dir, { historyFile: path.join(dir, 'h.jsonl'), history: false });
    await tools.ontology_upsert_object.execute({ packageId: 'retail.store-inventory', object: newObject('B1') }, {});
    const result = await tools.ontology_history.execute({}, {});
    assert.equal(result.entries.length, 0);
  });

  const total = pass + failures.length;
  console.log(`\n${pass}/${total} passed`);
  if (failures.length) {
    for (const f of failures) console.error('\n' + f.name + '\n', f.error);
    process.exit(1);
  }
})();
