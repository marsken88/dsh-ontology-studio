/**
 * Panel write routes: human edits, CSRF guard, validation feedback.
 * Run `node test/panel-writes.test.cjs`.
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

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontology-pw-'));
  fs.copyFileSync(ASSET, path.join(dir, 'store-inventory.ir.json'));
  fs.copyFileSync(RECORDS, path.join(dir, 'store-inventory.records.json'));
  return dir;
}

function boot(overrides = {}) {
  const routes = [];
  const history = [];
  const mod = require('../lib/panel-writes.mjs');
  const store = overrides.store;
  mod.registerWriteRoutes(
    { webServer: { register: (r) => { routes.push(r); return () => {}; } } },
    Object.assign(
      {
        store,
        prefix: '/dsh-ontology-studio',
        writeMode: 'open',
        noteHistory: async (entry) => history.push(entry),
      },
      overrides.options
    )
  );
  return { handler: routes[0].handler, history };
}

function post(handler, url, body, headers = {}) {
  return new Promise((resolve) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const req = {
      method: headers.method || 'POST',
      url,
      headers: Object.assign({ 'content-type': 'application/json', host: '127.0.0.1:64155' }, headers),
      on(event, cb) {
        if (event === 'data') cb(Buffer.from(payload));
        if (event === 'end') cb();
        return this;
      },
      destroy() {},
    };
    const res = {
      writeHead(code) { this.code = code; },
      end(out) { resolve({ code: this.code, body: JSON.parse(String(out || '{}')) }); },
    };
    handler(req, res).catch((error) => resolve({ code: 'THROW', body: { message: error.message } }));
  });
}

(async () => {
  const { createStore } = await import('../lib/store.mjs');
  const newObject = (id, extra = {}) => ({
    id,
    name: '新对象' + id,
    keys: ['id'],
    properties: [{ name: 'id', label: '编号', type: 'string', required: true }],
    ...extra,
  });

  console.log('\nCSRF 防护');

  await it('跨站 origin 被拒绝', async () => {
    const store = createStore({ dir: tempDir() });
    const { handler } = boot({ store });
    const r = await post(handler, '/dsh-ontology-studio/write/save-object', { packageId: 'x', object: newObject('A') }, { origin: 'https://evil.example' });
    assert.equal(r.code, 403);
    assert.equal(r.body.error, 'cross_origin');
  });

  await it('sec-fetch-site: cross-site 被拒绝', async () => {
    const store = createStore({ dir: tempDir() });
    const { handler } = boot({ store });
    const r = await post(handler, '/dsh-ontology-studio/write/save-object', { packageId: 'x', object: newObject('A') }, { 'sec-fetch-site': 'cross-site' });
    assert.equal(r.code, 403);
  });

  await it('同源请求放行', async () => {
    const store = createStore({ dir: tempDir() });
    const { handler } = boot({ store });
    const r = await post(
      handler,
      '/dsh-ontology-studio/write/save-object',
      { packageId: 'retail.store-inventory', object: newObject('PaneMade') },
      { origin: 'http://127.0.0.1:64155', 'sec-fetch-site': 'same-origin' }
    );
    assert.equal(r.code, 200, JSON.stringify(r.body));
  });

  console.log('\n保存对象');

  await it('新建对象落盘并记历史', async () => {
    const dir = tempDir();
    const store = createStore({ dir });
    const { handler, history } = boot({ store });
    const r = await post(handler, '/dsh-ontology-studio/write/save-object', {
      packageId: 'retail.store-inventory',
      object: newObject('Warehouse', { name: '仓库' }),
    });
    assert.equal(r.code, 200);
    assert.equal(r.body.action, 'created');

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8'));
    assert.ok(onDisk.objects.some((o) => o.id === 'Warehouse'));
    assert.equal(history.length, 1);
    assert.equal(history[0].op, 'upsert_object');
    assert.ok(history[0].summary.includes('面板'));
  });

  await it('更新已有对象', async () => {
    const dir = tempDir();
    const store = createStore({ dir });
    const { handler } = boot({ store });
    // 改名字要基于现有对象，不能拿最小骨架覆盖（那会把属性与规则打断）
    const current = JSON.parse(fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8'));
    const inventory = current.objects.find((o) => o.id === 'Inventory');
    const r = await post(handler, '/dsh-ontology-studio/write/save-object', {
      packageId: 'retail.store-inventory',
      object: Object.assign({}, inventory, { name: '库存改成别的名字' }),
    });
    assert.equal(r.code, 200, JSON.stringify(r.body));
    assert.equal(r.body.action, 'updated');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8'));
    assert.equal(onDisk.objects.find((o) => o.id === 'Inventory').name, '库存改成别的名字');
  });

  await it('会让整包失效的改动被拒绝，并返回校验器的原始问题', async () => {
    const dir = tempDir();
    const store = createStore({ dir });
    const { handler } = boot({ store });
    const before = fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8');
    const r = await post(handler, '/dsh-ontology-studio/write/save-object', {
      packageId: 'retail.store-inventory',
      object: { id: 'Broken', name: '坏对象', keys: [], properties: [] },
    });
    assert.equal(r.code, 422);
    assert.equal(r.body.error, 'invalid');
    assert.ok(r.body.problems.length > 0, '应当带回具体问题');
    assert.equal(fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8'), before, '不得落盘');
  });

  await it('缺 body 或对象缺 id 时 400', async () => {
    const store = createStore({ dir: tempDir() });
    const { handler } = boot({ store });
    assert.equal((await post(handler, '/dsh-ontology-studio/write/save-object', {}, {})).code, 400);
    assert.equal((await post(handler, '/dsh-ontology-studio/write/save-object', { packageId: 'x', object: { name: 'no id' } })).code, 400);
    assert.equal((await post(handler, '/dsh-ontology-studio/write/save-object', 'not json')).code, 400);
  });

  await it('资产包不存在时 404', async () => {
    const store = createStore({ dir: tempDir() });
    const { handler } = boot({ store });
    const r = await post(handler, '/dsh-ontology-studio/write/save-object', { packageId: 'nope', object: newObject('A') });
    assert.equal(r.code, 404);
  });

  console.log('\n删除对象');

  await it('有引用时不带 cascade 返回 409 并说明依赖', async () => {
    const store = createStore({ dir: tempDir() });
    const { handler } = boot({ store });
    const r = await post(handler, '/dsh-ontology-studio/write/delete-object', {
      packageId: 'retail.store-inventory',
      objectId: 'Store',
    });
    assert.equal(r.code, 409);
    assert.equal(r.body.error, 'has_dependents');
    assert.ok(r.body.dependents.links > 0);
  });

  await it('带 cascade 时连带清理关系、动作、策略与 Agent', async () => {
    const dir = tempDir();
    const store = createStore({ dir });
    const { handler } = boot({ store });
    const r = await post(handler, '/dsh-ontology-studio/write/delete-object', {
      packageId: 'retail.store-inventory',
      objectId: 'Inventory',
      cascade: true,
    });
    assert.equal(r.code, 200, JSON.stringify(r.body));

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8'));
    assert.ok(!onDisk.objects.some((o) => o.id === 'Inventory'));
    assert.ok(!(onDisk.links || []).some((l) => l.source === 'Inventory' || l.target === 'Inventory'));
    assert.ok(!(onDisk.agents || []).some((a) => (a.usesObjects || []).includes('Inventory')), 'Agent 引用也要摘干净');
  });

  await it('没有依赖的对象可以直接删', async () => {
    const dir = tempDir();
    const store = createStore({ dir });
    const { handler } = boot({ store });
    await post(handler, '/dsh-ontology-studio/write/save-object', { packageId: 'retail.store-inventory', object: newObject('Lonely') });
    const r = await post(handler, '/dsh-ontology-studio/write/delete-object', { packageId: 'retail.store-inventory', objectId: 'Lonely' });
    assert.equal(r.code, 200, JSON.stringify(r.body));
  });

  await it('删不存在的对象 404', async () => {
    const store = createStore({ dir: tempDir() });
    const { handler } = boot({ store });
    const r = await post(handler, '/dsh-ontology-studio/write/delete-object', { packageId: 'retail.store-inventory', objectId: 'Ghost' });
    assert.equal(r.code, 404);
  });

  console.log('\n模式与协议');

  await it('只读模式一律 403，且磁盘不变', async () => {
    const dir = tempDir();
    const store = createStore({ dir });
    const { handler } = boot({ store, options: { writeMode: 'readonly' } });
    const before = fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8');
    const r = await post(handler, '/dsh-ontology-studio/write/save-object', { packageId: 'retail.store-inventory', object: newObject('Nope') });
    assert.equal(r.code, 403);
    assert.equal(r.body.error, 'readonly');
    assert.equal(fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8'), before);
  });

  await it('GET 打到写路由是 405', async () => {
    const store = createStore({ dir: tempDir() });
    const { handler } = boot({ store });
    const r = await post(handler, '/dsh-ontology-studio/write/save-object', {}, { method: 'GET' });
    assert.equal(r.code, 405);
  });

  await it('未知写路由 404', async () => {
    const store = createStore({ dir: tempDir() });
    const { handler } = boot({ store });
    const r = await post(handler, '/dsh-ontology-studio/write/nope', {});
    assert.equal(r.code, 404);
  });

  const total = pass + failures.length;
  console.log(`\n${pass}/${total} passed`);
  if (failures.length) {
    for (const f of failures) console.error('\n' + f.name + '\n', f.error);
    process.exit(1);
  }
})();
