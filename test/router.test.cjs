/**
 * Router and evaluation edges: hostile query strings, odd methods, and the
 * numeric corners of the rule evaluator.
 * Run `node test/router.test.cjs`.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
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

(async () => {
  const { registerRoutes } = await import('../lib/api.mjs');
  const { evaluateRules } = await import('../lib/rules.mjs');
  const { evaluateExpression } = await import('../lib/expr.mjs');
  const { validateIr } = await import('../lib/ir.mjs');

  function makeHandler(overrides = {}) {
    const routes = [];
    const ctx = { webServer: { register: (r) => { routes.push(r); return () => {}; } } };
    const store = {
      list: async () => ({ entries: [], missingDir: false }),
      get: async () => ({ entry: null, entries: [] }),
    };
    registerRoutes(
      ctx,
      Object.assign(
        {
          store,
          prefix: '/dsh-ontology-studio',
          trace: { enabled: true, list: async () => [] },
          panel: { append: async () => {} },
        },
        overrides
      )
    );
    return routes[0].handler;
  }

  function call(handler, url, method = 'GET', body) {
    return new Promise((resolve) => {
      const req = {
        method,
        url,
        headers: {},
        on(event, cb) {
          if (event === 'data' && body !== undefined) cb(Buffer.from(body));
          if (event === 'end') cb();
          return this;
        },
        destroy() {},
      };
      const res = {
        writeHead(code) { this.code = code; },
        end(payload) { resolve({ code: this.code, body: String(payload || '') }); },
      };
      handler(req, res).catch((error) => resolve({ code: 'THROW', body: error.message }));
    });
  }

  console.log('\n入参');

  await it('200KB 的 id 不会被原样回显', async () => {
    const r = await call(makeHandler(), '/dsh-ontology-studio/package?id=' + 'x'.repeat(200000));
    assert.equal(r.code, 404);
    assert.ok(r.body.length < 400, '响应不应超过 400 字节，实际 ' + r.body.length);
    assert.ok(r.body.includes('字符'), '应当说明被截断');
  });

  await it('路径穿越与空字节只是普通的不存在', async () => {
    const h = makeHandler();
    for (const id of ['../../../../etc/passwd', 'a%00b', '%ZZ', '<script>alert(1)</script>']) {
      const r = await call(h, '/dsh-ontology-studio/package?id=' + id);
      assert.equal(r.code, 404, id + ' 应当是 404');
      assert.ok(r.body.includes('not_found'));
    }
  });

  await it('未知路由也不回显超长路径', async () => {
    const r = await call(makeHandler(), '/dsh-ontology-studio/' + 'y'.repeat(50000));
    assert.equal(r.code, 404);
    assert.ok(r.body.length < 400, '实际 ' + r.body.length);
  });

  console.log('\n方法');

  await it('HEAD 返回 200 但没有响应体', async () => {
    const r = await call(makeHandler(), '/dsh-ontology-studio/status', 'HEAD');
    assert.equal(r.code, 200);
    assert.equal(r.body, '', 'HEAD 不得携带响应体');
  });

  await it('PUT / DELETE / OPTIONS 一律 405', async () => {
    for (const method of ['PUT', 'DELETE', 'OPTIONS']) {
      const r = await call(makeHandler(), '/dsh-ontology-studio/status', method);
      assert.equal(r.code, 405, method + ' 应当 405');
    }
  });

  console.log('\nlimit 与请求体');

  await it('limit 被夹到合法区间', async () => {
    const seen = [];
    const handler = makeHandler({
      trace: { enabled: true, list: async (n) => { seen.push(n); return []; } },
    });
    await call(handler, '/dsh-ontology-studio/traces?limit=-5');
    await call(handler, '/dsh-ontology-studio/traces?limit=999999');
    await call(handler, '/dsh-ontology-studio/traces?limit=abc');
    await call(handler, '/dsh-ontology-studio/traces?limit=Infinity');
    assert.deepEqual(seen, [1, 200, 40, 40]);
  });

  await it('超过 64KB 的请求体被拒绝', async () => {
    const r = await call(makeHandler(), '/dsh-ontology-studio/panel-report', 'POST', 'x'.repeat(70000));
    assert.equal(r.code, 400);
    assert.ok(r.body.includes('body too large'));
  });

  await it('GET 打 panel-report 是 405', async () => {
    const r = await call(makeHandler(), '/dsh-ontology-studio/panel-report', 'GET');
    assert.equal(r.code, 405);
  });

  await it('__proto__ 参数不会污染原型', async () => {
    await call(makeHandler(), '/dsh-ontology-studio/records?__proto__=polluted&id=x');
    assert.equal({}.polluted, undefined);
  });

  console.log('\n求值边界');

  await it('除零变成一条带错误的违规，而不是崩溃', () => {
    const ir = {
      irVersion: '0.1.0', id: 'p.n', name: 'n', version: '0.1.0', status: 'draft',
      objects: [{ id: 'Item', name: '条目', keys: ['id'], properties: [{ name: 'qty', type: 'number' }, { name: 'price', type: 'money' }] }],
      links: [], actions: [], policies: [],
      rules: [{ id: 'r.div', name: 'div', expression: 'price / qty > 1', severity: 'warn', enabled: true }],
    };
    const result = evaluateRules(ir, { objects: { Item: [{ qty: 0, price: 10 }, { qty: 2, price: 10 }] } });
    const rule = result.results[0];
    assert.equal(rule.errors, 1, '除零那一行应当计入 errors');
    assert.equal(rule.evaluated, 1, '另一行正常求值');
    assert.equal(rule.violations.length, 2);
    assert.ok(rule.violations[0].error.includes('除数为零'));
  });

  await it('注入式表达式一律被词法层拒绝', () => {
    for (const source of ['qty = 5', 'qty > 1; alert(1)', 'max(qty, 1) > 2', 'qty % 2', 'qty.constructor > 1']) {
      assert.throws(() => evaluateExpression(source, { qty: 5 }), undefined, source + ' 应当被拒绝');
    }
  });

  await it('超长表达式在校验阶段就被拦下', () => {
    const ir = {
      irVersion: '0.1.0', id: 'p.n', name: 'n', version: '0.1.0', status: 'draft',
      objects: [{ id: 'Item', name: '条目', keys: ['id'], properties: [{ name: 'qty', type: 'number' }] }],
      links: [], actions: [], policies: [],
      rules: [{ id: 'r.big', name: 'big', expression: 'qty > 1 ' + '&& qty > 1 '.repeat(500), severity: 'warn', enabled: true }],
    };
    assert.ok(validateIr(ir).problems.some((p) => p.code === 'too-long'));
  });

  const total = pass + failures.length;
  console.log(`\n${pass}/${total} passed`);
  if (failures.length) {
    for (const f of failures) console.error('\n' + f.name + '\n', f.error);
    process.exit(1);
  }
})();
