/**
 * Panel HTTP API tests: drive the registered route handler with Node-style
 * request/response stubs, no server needed. Run `node test/api.test.cjs`.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PREFIX = '/dsh-ontology-studio';

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

function register(dir) {
  const routes = [];
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
  };
  return { ctx, routes };
}

function response() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
    },
    end(body) {
      this.body = body || '';
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

async function call(route, url, method = 'GET', body) {
  const res = response();
  const req = { method, url, headers: { 'user-agent': 'test' } };
  // Minimal readable stream so readBody() can consume it.
  const listeners = {};
  req.on = (event, fn) => {
    (listeners[event] = listeners[event] || []).push(fn);
    return req;
  };
  req.destroy = () => {};
  const pending = route.handler(req, res);
  if (body !== undefined) {
    for (const fn of listeners.data || []) fn(Buffer.from(body));
  }
  for (const fn of listeners.end || []) fn();
  await pending;
  return res;
}

(async () => {
  const { registerRoutes } = await import('../lib/api.mjs');
  const { createStore } = await import('../lib/store.mjs');

  const store = createStore({ dir: path.join(ROOT, 'assets') });
  const { ctx, routes } = register(ROOT);
  const dispose = registerRoutes(ctx, { store, prefix: PREFIX });

  console.log('\nregistration');

  await it('注册一条 prefix 路由并返回 disposer', () => {
    assert.equal(routes.length, 1);
    assert.equal(routes[0].kind, 'prefix');
    assert.equal(routes[0].path, PREFIX);
    assert.equal(typeof dispose, 'function');
  });

  console.log('\nGET /status');

  await it('返回资产包摘要与校验状态', async () => {
    const res = await call(routes[0], `${PREFIX}/status`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.value.readOnly, false, '默认不是只读模式');
    assert.equal(body.value.approval, 'destructive', '默认破坏性操作需审批');
    assert.equal(body.value.packages.length, 1);
    const pkg = body.value.packages[0];
    assert.equal(pkg.id, 'retail.store-inventory');
    assert.equal(pkg.objects, 6);
    assert.equal(pkg.links, 5);
    assert.equal(pkg.ok, true);
    assert.equal(pkg.problemCount, 0);
    assert.deepEqual(body.value.problems, []);
  });

  console.log('\nGET /package');

  await it('返回完整 IR', async () => {
    const res = await call(routes[0], `${PREFIX}/package?id=retail.store-inventory`);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.value.ir.id, 'retail.store-inventory');
    assert.equal(body.value.ir.objects.length, 6);
    assert.equal(body.value.ok, true);
  });

  await it('缺 id 返回 400', async () => {
    const res = await call(routes[0], `${PREFIX}/package`);
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'missing_id');
  });

  await it('未知包返回 404', async () => {
    const res = await call(routes[0], `${PREFIX}/package?id=nope`);
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'not_found');
  });

  console.log('\nGET /impact');

  await it('返回对象影响分析', async () => {
    const res = await call(routes[0], `${PREFIX}/impact?id=retail.store-inventory&object=Inventory`);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.value.object.id, 'Inventory');
    assert.equal(body.value.dependents, 6);
  });

  await it('缺参数返回 400，未知对象返回 404', async () => {
    const missing = await call(routes[0], `${PREFIX}/impact?id=retail.store-inventory`);
    assert.equal(missing.statusCode, 400);
    const unknown = await call(routes[0], `${PREFIX}/impact?id=retail.store-inventory&object=Ghost`);
    assert.equal(unknown.statusCode, 404);
    assert.equal(unknown.json().error, 'object_not_found');
  });

  console.log('\nGET /records');

  await it('返回行数与抽样，limit 生效', async () => {
    const res = await call(routes[0], `${PREFIX}/records?id=retail.store-inventory&limit=2`);
    assert.equal(res.statusCode, 200, res.body.slice(0, 200));
    const body = res.json();
    assert.equal(body.value.totalRows, 11);
    const inv = body.value.objects.find((o) => o.id === 'Inventory');
    assert.equal(inv.rows, 5);
    assert.equal(inv.sample.length, 2);
  });

  await it('按对象过滤；缺参数 400；未知包 404', async () => {
    const one = await call(routes[0], `${PREFIX}/records?id=retail.store-inventory&object=Store`);
    assert.equal(one.statusCode, 200);
    assert.deepEqual(one.json().value.objects.map((o) => o.id), ['Store']);

    assert.equal((await call(routes[0], `${PREFIX}/records`)).statusCode, 400);
    assert.equal((await call(routes[0], `${PREFIX}/records?id=nope`)).statusCode, 404);
  });

  console.log('\nPOST /panel-report');

  await it('面板健康上报被接收并落盘', async () => {
    const appended = [];
    const fakePanel = { enabled: true, append: async (e) => { appended.push(e); } };
    const alt = register(ROOT);
    registerRoutes(alt.ctx, { store, prefix: PREFIX, panel: fakePanel });
    const res = await call(alt.routes[0], `${PREFIX}/panel-report`, 'POST', JSON.stringify({ phase: 'render', page: 'data' }));
    assert.equal(res.statusCode, 200);
    assert.equal(appended.length, 1);
    assert.equal(appended[0].phase, 'render');
    assert.equal(appended[0].page, 'data');
    assert.ok(typeof appended[0].receivedAt === 'number');
  });

  await it('GET 与坏 body 分别 405 / 400', async () => {
    const alt = register(ROOT);
    registerRoutes(alt.ctx, { store, prefix: PREFIX, panel: { enabled: true, append: async () => {} } });
    const wrongMethod = await call(alt.routes[0], `${PREFIX}/panel-report`, 'GET');
    assert.equal(wrongMethod.statusCode, 405);

    const badBody = await call(alt.routes[0], `${PREFIX}/panel-report`, 'POST', '{not json');
    assert.equal(badBody.statusCode, 400);
    assert.equal(badBody.json().error, 'bad_body');
  });

  console.log('\nprotocol');

  await it('非 GET 方法返回 405', async () => {
    const res = await call(routes[0], `${PREFIX}/status`, 'POST');
    assert.equal(res.statusCode, 405);
    assert.equal(res.json().error, 'method_not_allowed');
  });

  await it('未知路径返回 404', async () => {
    const res = await call(routes[0], `${PREFIX}/whatever`);
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'unknown_route');
  });

  console.log('\nGET /traces');

  await it('没有 trace 存储时返回 enabled:false 而不是报错', async () => {
    const res = await call(routes[0], `${PREFIX}/traces`);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.value.enabled, false);
    assert.deepEqual(body.value.entries, []);
  });

  await it('有 trace 时返回条目并限制条数', async () => {
    const calls = [];
    const fakeTrace = {
      enabled: true,
      list: async (limit) => {
        calls.push(limit);
        return [{ ts: 1, tool: 'ontology_list', ok: true, ms: 3, summary: 'ontology_list: ' }];
      },
    };
    const alt = register(ROOT);
    registerRoutes(alt.ctx, { store, prefix: PREFIX, trace: fakeTrace });
    const res = await call(alt.routes[0], `${PREFIX}/traces?limit=5`);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.value.enabled, true);
    assert.equal(body.value.entries.length, 1);
    assert.deepEqual(calls, [5]);
  });

  await it('limit 被夹在 1..200 之间', async () => {
    let seen = null;
    const fakeTrace = { enabled: true, list: async (limit) => { seen = limit; return []; } };
    const alt = register(ROOT);
    registerRoutes(alt.ctx, { store, prefix: PREFIX, trace: fakeTrace });
    await call(alt.routes[0], `${PREFIX}/traces?limit=9999`);
    assert.equal(seen, 200);
    await call(alt.routes[0], `${PREFIX}/traces?limit=0`);
    assert.equal(seen, 1);
  });

  await it('readOnly 选项透出到 /status', async () => {
    const alt = register(ROOT);
    registerRoutes(alt.ctx, { store, prefix: PREFIX, readOnly: true });
    const res = await call(alt.routes[0], `${PREFIX}/status`);
    assert.equal(res.json().value.readOnly, true);
  });

  await it('资产目录不存在时 status 仍返回 200 并标记 missingDir', async () => {
    const empty = createStore({ dir: path.join(ROOT, 'no-such-dir') });
    const alt = register(ROOT);
    registerRoutes(alt.ctx, { store: empty, prefix: PREFIX });
    const res = await call(alt.routes[0], `${PREFIX}/status`);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.value.missingDir, true);
    assert.deepEqual(body.value.packages, []);
  });

  await it('/evaluate 返回规则求值结果（只读）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontology-eval-'));
    fs.copyFileSync(path.join(ROOT, 'assets', 'store-inventory.ir.json'), path.join(dir, 'store-inventory.ir.json'));
    fs.copyFileSync(path.join(ROOT, 'assets', 'store-inventory.records.json'), path.join(dir, 'store-inventory.records.json'));

    const mod = await import('../index.js');
    const routes = [];
    mod.apply(
      {
        tools: { register: () => () => {} },
        effect: (run) => run(),
        inject: (deps, cb) => {
          if (deps.includes('webServer')) cb({ webServer: { register: (r) => { routes.push(r); return () => {}; } } });
          return () => {};
        },
        get: () => undefined,
        on: () => {},
        off: () => {},
      },
      { assetsDir: dir, trace: false, approval: 'never' }
    );

    const call = (url) =>
      new Promise((resolve) => {
        const res = { writeHead: (code) => { res.code = code; }, end: (body) => resolve({ code: res.code, body: JSON.parse(body || '{}') }) };
        routes[routes.length - 1].handler({ method: 'GET', url, headers: {}, on() { return this; }, destroy() {} }, res);
      });

    const ok = await call('/dsh-ontology-studio/evaluate?id=retail.store-inventory');
    assert.equal(ok.code, 200);
    assert.equal(ok.body.value.available, true);
    assert.equal(ok.body.value.summary.rows, 11);
    assert.equal(ok.body.value.summary.violations, 4);

    const missingId = await call('/dsh-ontology-studio/evaluate');
    assert.equal(missingId.code, 400);

    const notFound = await call('/dsh-ontology-studio/evaluate?id=ghost');
    assert.equal(notFound.code, 404);
  });
  await it('handler 抛错时返回 500 而不是让请求挂住', async () => {
    const broken = {
      list: async () => {
        throw new Error('boom');
      },
      get: async () => {
        throw new Error('boom');
      },
    };
    const alt = register(ROOT);
    registerRoutes(alt.ctx, { store: broken, prefix: PREFIX });
    const res = await call(alt.routes[0], `${PREFIX}/status`);
    assert.equal(res.statusCode, 500);
    assert.equal(res.json().error, 'internal');
  });

  console.log('\nGET /sync');

  await it('只列出有同步记录的包，并带上行数与说明', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-sync-'));
    const pkg = {
      irVersion: '1.0.0',
      id: 'demo.stock',
      name: '库存快照',
      version: '0.1.0',
      status: 'draft',
      objects: [{ id: 'Stock', name: '库存', keys: ['storeId'], properties: [{ name: 'storeId', type: 'string' }] }],
      links: [],
      rules: [],
      actions: [],
    };
    fs.writeFileSync(path.join(dir, 'demo.stock.ir.json'), JSON.stringify(pkg, null, 2));
    fs.writeFileSync(
      path.join(dir, 'demo.stock.sync.json'),
      JSON.stringify({
        packageId: 'demo.stock',
        objectId: 'Stock',
        path: 'D:/data/stock.csv',
        at: '2026-11-16T09:00:00.000Z',
        rowCount: 3,
        columnCount: 2,
        runs: 2,
        columns: [],
        changes: { first: false, dataChanged: true, rowDelta: 1, added: [], removed: [], typeChanged: [], schemaChanged: false },
        previous: { at: '2026-11-15T09:00:00.000Z', hash: 'sha256-0000', rowCount: 2 },
      })
    );

    const alt = register(dir);
    registerRoutes(alt.ctx, { store: createStore({ dir }), prefix: PREFIX });
    const res = await call(alt.routes[0], `${PREFIX}/sync`);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.value.count, 1);
    const source = body.value.sources[0];
    assert.equal(source.packageId, 'demo.stock');
    assert.equal(source.objectId, 'Stock');
    assert.equal(source.rowCount, 3);
    assert.equal(source.runs, 2);
    assert.match(source.summary, /上次同步/);
    assert.match(source.summary, /行数 \+1/);

    // 过滤到一个没有同步记录的包：列出来是空，而不是编一条
    fs.writeFileSync(path.join(dir, 'manual.ir.json'), JSON.stringify({ ...pkg, id: 'manual' }, null, 2));
    const none = await call(alt.routes[0], `${PREFIX}/sync?id=manual`);
    assert.equal(none.json().value.count, 0);
    assert.deepEqual(none.json().value.sources, []);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  const total = pass + failures.length;
  console.log(`\n${pass}/${total} passed`);
  if (failures.length) {
    for (const f of failures) console.error('\n' + f.name + '\n', f.error);
    process.exit(1);
  }
})();
