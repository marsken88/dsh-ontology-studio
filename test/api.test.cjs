/**
 * Panel HTTP API tests: drive the registered route handler with Node-style
 * request/response stubs, no server needed. Run `node test/api.test.cjs`.
 */
const assert = require('node:assert/strict');
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

async function call(route, url, method = 'GET') {
  const res = response();
  await route.handler({ method, url }, res);
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

  const total = pass + failures.length;
  console.log(`\n${pass}/${total} passed`);
  if (failures.length) {
    for (const f of failures) console.error('\n' + f.name + '\n', f.error);
    process.exit(1);
  }
})();
