/**
 * Diff + upgrade tests.
 * Run `node test/diff.test.cjs`.
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

/** An "upgraded" copy: one new object, one changed rule severity. */
function upgraded(ir) {
  const next = JSON.parse(JSON.stringify(ir));
  next.version = '1.1.0';
  next.description = '升级版';
  next.objects.push({
    id: 'Warehouse',
    name: '仓库',
    keys: ['warehouseNo'],
    properties: [{ name: 'warehouseNo', type: 'string', required: true }],
  });
  next.rules[0].severity = 'error';
  return next;
}

async function setup(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontology-diff-'));
  const catalog = fs.mkdtempSync(path.join(os.tmpdir(), 'ontology-diffcat-'));
  fs.copyFileSync(ASSET, path.join(dir, 'store-inventory.ir.json'));
  const ir = JSON.parse(fs.readFileSync(ASSET, 'utf8'));
  if (options.catalogVersion) {
    fs.writeFileSync(path.join(catalog, 'store-inventory.ir.json'), JSON.stringify(upgraded(ir), null, 2));
  }

  const mod = await import('../index.js');
  const registered = [];
  const ctx = {
    tools: { register: (d) => { registered.push(d); return () => {}; } },
    effect: (run) => run(),
    inject: () => () => {},
    get: () => undefined,
  };
  mod.apply(ctx, {
    assetsDir: dir,
    catalogDir: catalog,
    approval: options.approval || 'never',
    trace: false,
    historyFile: path.join(dir, 'history.jsonl'),
  });
  return { dir, catalog, tools: Object.fromEntries(registered.map((d) => [d.name, d])) };
}

(async () => {
  const { diffPackages, describeDiff } = await import('../lib/diff.mjs');
  const base = JSON.parse(fs.readFileSync(ASSET, 'utf8'));

  console.log('\ndiffPackages');

  await it('完全相同的两份报 identical', () => {
    const diff = diffPackages(base, JSON.parse(JSON.stringify(base)));
    assert.equal(diff.identical, true);
    assert.deepEqual(diff.summary, { added: 0, removed: 0, changed: 0 });
    assert.equal(describeDiff(diff), '两个版本完全一致');
  });

  await it('新增对象 / 改规则 / 改动作都能定位到具体条目', () => {
    const next = JSON.parse(JSON.stringify(base));
    next.objects.push({ id: 'Warehouse', name: '仓库', keys: ['k'], properties: [{ name: 'k', type: 'string' }] });
    next.rules[0].severity = 'error';
    next.actions[0].approvalRequired = false;

    const diff = diffPackages(base, next);
    const objects = diff.sections.find((s) => s.collection === 'objects');
    assert.deepEqual(objects.added, ['Warehouse']);

    const rules = diff.sections.find((s) => s.collection === 'rules');
    assert.equal(rules.changed[0].id, next.rules[0].id);
    assert.equal(rules.changed[0].changes[0].field, 'severity');

    const actions = diff.sections.find((s) => s.collection === 'actions');
    assert.equal(actions.changed[0].changes[0].field, 'approvalRequired');
  });

  await it('属性增删改逐条列出', () => {
    const next = JSON.parse(JSON.stringify(base));
    const inventory = next.objects.find((o) => o.id === 'Inventory');
    inventory.properties.push({ name: 'inTransitQty', type: 'number' });
    inventory.properties = inventory.properties.filter((p) => p.name !== 'lockedQty');
    inventory.properties.find((p) => p.name === 'safetyStock').type = 'integer';

    const diff = diffPackages(base, next);
    const objects = diff.sections.find((s) => s.collection === 'objects');
    const changes = objects.changed.find((c) => c.id === 'Inventory').changes;
    assert.ok(changes.some((c) => c.field === 'property' && c.op === 'added' && c.name === 'inTransitQty'));
    assert.ok(changes.some((c) => c.field === 'property' && c.op === 'removed' && c.name === 'lockedQty'));
    assert.ok(changes.some((c) => c.field === 'property.type' && c.name === 'safetyStock'));
  });

  await it('摘要能读成人话', () => {
    const diff = diffPackages(base, upgraded(base));
    const text = describeDiff(diff);
    assert.ok(text.includes('objects +1'));
    assert.ok(text.includes('rules ~1'));
  });

  console.log('\n工具：diff');

  await it('对比已安装与 catalog 里的新版本', async () => {
    const { tools } = await setup({ catalogVersion: true });
    const result = await tools.ontology_diff.execute(
      { packageId: 'retail.store-inventory', againstPackageId: 'retail.store-inventory', againstSource: 'catalog' },
      {}
    );
    assert.equal(result.ok, true, result.message);
    assert.equal(result.diff.to.version, '1.1.0');
    assert.deepEqual(result.diff.sections.find((s) => s.collection === 'objects').added, ['Warehouse']);
    const rendered = tools.ontology_diff.output.render({}, result)[0].text;
    assert.ok(rendered.includes('v1.0.0 → v1.1.0'));
  });

  await it('目标不存在时报错', async () => {
    const { tools } = await setup();
    const result = await tools.ontology_diff.execute(
      { packageId: 'retail.store-inventory', againstPackageId: 'nope' },
      {}
    );
    assert.equal(result.ok, false);
    assert.ok(result.message.includes('nope'));
  });

  console.log('\n工具：upgrade');

  await it('有同 id 的新版本时原位升级并记历史', async () => {
    const { dir, tools } = await setup({ catalogVersion: true });
    const result = await tools.ontology_upgrade.execute({ packageId: 'retail.store-inventory' }, {});
    assert.equal(result.ok, true, result.message);
    assert.equal(result.from, '1.0.0');
    assert.equal(result.to, '1.1.0');

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8'));
    assert.equal(onDisk.version, '1.1.0');
    assert.ok(onDisk.objects.some((o) => o.id === 'Warehouse'));

    const history = fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(history[history.length - 1].op, 'upgrade');
    assert.ok(history[history.length - 1].summary.includes('1.1.0'));
  });

  await it('dryRun 只校验不写盘', async () => {
    const { dir, tools } = await setup({ catalogVersion: true });
    const beforeText = fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8');
    const result = await tools.ontology_upgrade.execute({ packageId: 'retail.store-inventory', dryRun: true }, {});
    assert.equal(result.ok, true, result.message);
    assert.equal(result.to, '1.1.0');
    assert.equal(fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8'), beforeText, 'dryRun 不得写盘');
    const rendered = tools.ontology_upgrade.output.render({}, result)[0].text;
    assert.ok(!rendered.includes('undefined'), 'dryRun 渲染不能出现 undefined：' + rendered);
    assert.ok(rendered.includes('dryRun'), '应说明未写盘：' + rendered);
  });

  await it('市场里没有其它版本时拒绝', async () => {
    const { tools } = await setup();
    const result = await tools.ontology_upgrade.execute({ packageId: 'retail.store-inventory' }, {});
    assert.equal(result.ok, false);
    assert.ok(result.message.includes('其它版本'));
  });

  await it('没有安装时报错', async () => {
    const { tools } = await setup();
    const result = await tools.ontology_upgrade.execute({ packageId: 'nope' }, {});
    assert.equal(result.ok, false);
    assert.ok(result.message.includes('没有安装'));
  });

  await it('审批被拒绝时不写盘', async () => {
    const { dir, tools } = await setup({
      catalogVersion: true,
      approval: 'destructive',
    });
    // 没有 approval 服务 → 应失败关闭
    const before = fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8');
    const result = await tools.ontology_upgrade.execute({ packageId: 'retail.store-inventory' }, { agent: { id: 's1' } });
    assert.equal(result.ok, false);
    assert.equal(result.approval, 'unavailable');
    assert.equal(fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8'), before);
  });

  const total = pass + failures.length;
  console.log(`\n${pass}/${total} passed`);
  if (failures.length) {
    for (const f of failures) console.error('\n' + f.name + '\n', f.error);
    process.exit(1);
  }
})();
