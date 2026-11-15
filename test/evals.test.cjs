/**
 * Evaluation runs and comparability tests.
 * Run `node test/evals.test.cjs`.
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

(async () => {
  const { runEvaluation, compareRuns, digest } = await import('../lib/evals.mjs');
  const ir = JSON.parse(fs.readFileSync(ASSET, 'utf8'));
  const records = JSON.parse(fs.readFileSync(RECORDS, 'utf8'));

  console.log('\n运行记录');

  await it('一次运行带齐三个条件指纹', () => {
    const run = runEvaluation(ir, records);
    assert.equal(run.packageId, ir.id);
    assert.equal(run.packageVersion, ir.version);
    assert.equal(run.conditions.packageId, ir.id);
    assert.ok(run.conditions.rules.startsWith('sha256-'));
    assert.ok(run.conditions.data.startsWith('sha256-'));
    assert.equal(run.rows, 11);
    assert.equal(run.violations, 4);
  });

  await it('逐条规则给出违规数', () => {
    const run = runEvaluation(ir, records);
    const low = run.byRule.find((r) => r.rule === 'inventory.lowStockWarning');
    assert.equal(low.violations, 3);
    assert.equal(low.object, 'Inventory');
  });

  await it('同样的输入产出同样的条件指纹（可复现）', () => {
    const a = runEvaluation(ir, records);
    const b = runEvaluation(ir, records);
    assert.notEqual(a.id, b.id, '运行 id 不同');
    assert.deepEqual(a.conditions, b.conditions, '条件指纹必须相同');
    assert.equal(a.violations, b.violations);
  });

  await it('digest 对顺序敏感、对内容稳定', () => {
    assert.equal(digest([1, 2]), digest([1, 2]));
    assert.notEqual(digest([1, 2]), digest([2, 1]));
  });

  console.log('\n可比性');

  await it('规则不变、数据变了 → 可比，并说明是哪一边变了', () => {
    const before = runEvaluation(ir, records);
    const changed = JSON.parse(JSON.stringify(records));
    changed.objects.Inventory[1].availableQty = 99;
    const after = runEvaluation(ir, changed);

    const cmp = compareRuns(before, after);
    assert.equal(cmp.comparable, true);
    assert.ok(cmp.varies.includes('数据'));
    assert.equal(cmp.delta.violations, -2, '补上缺货后应少两处违规');
  });

  await it('数据不变、规则变了 → 可比', () => {
    const before = runEvaluation(ir, records);
    const held = JSON.parse(JSON.stringify(ir));
    held.rules[0].expression = 'availableQty < 10';
    const after = runEvaluation(held, records);

    const cmp = compareRuns(before, after);
    assert.equal(cmp.comparable, true);
    assert.ok(cmp.varies.includes('规则'));
  });

  await it('规则和数据同时变了 → 拒绝比较并说明怎么办', () => {
    const before = runEvaluation(ir, records);
    const both = JSON.parse(JSON.stringify(ir));
    both.rules[0].expression = 'availableQty < 999';
    const data = JSON.parse(JSON.stringify(records));
    data.objects.Inventory[0].availableQty = 1;

    const cmp = compareRuns(before, runEvaluation(both, data));
    assert.equal(cmp.comparable, false);
    assert.deepEqual(cmp.differs.sort(), ['data', 'rules']);
    assert.ok(cmp.reason.includes('固定其中一个'));
  });

  await it('不同资产包之间不比较', () => {
    const a = runEvaluation(ir, records);
    const other = JSON.parse(JSON.stringify(ir));
    other.id = 'probe.other';
    const b = runEvaluation(other, records);
    const cmp = compareRuns(a, b);
    assert.equal(cmp.comparable, false);
    assert.ok(cmp.reason.includes('不同的资产包'));
  });

  await it('新增与删除的规则在逐条对比里标出来', () => {
    const before = runEvaluation(ir, records);
    const next = JSON.parse(JSON.stringify(ir));
    next.rules = next.rules.filter((r) => r.id !== 'inventory.stockoutAlert');
    next.rules.push({ id: 'inventory.zeroOnHand', name: '在库为零', expression: 'onHandQty <= 0', severity: 'info', enabled: true });
    const after = runEvaluation(next, records);

    const cmp = compareRuns(before, after);
    assert.equal(cmp.comparable, true);
    assert.ok(cmp.perRule.some((r) => r.rule === 'inventory.stockoutAlert' && r.status === 'removed'));
    assert.ok(cmp.perRule.some((r) => r.rule === 'inventory.zeroOnHand' && r.status === 'added'));
  });

  console.log('\n工具层');

  await it('跑两次再对比：工具能把结果串起来', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontology-evals-'));
    fs.copyFileSync(ASSET, path.join(dir, 'store-inventory.ir.json'));
    fs.copyFileSync(RECORDS, path.join(dir, 'store-inventory.records.json'));

    const mod = await import('../index.js');
    const registered = [];
    mod.apply(
      {
        tools: { register: (d) => { registered.push(d); return () => {}; } },
        effect: (run) => run(),
        inject: () => () => {},
        get: () => undefined,
        on: () => {},
        off: () => {},
      },
      { assetsDir: dir, trace: false, history: false, evalFile: path.join(dir, 'evals.jsonl') }
    );
    const tools = Object.fromEntries(registered.map((d) => [d.name, d]));

    const first = await tools.ontology_eval_run.execute({ packageId: 'retail.store-inventory' }, {});
    assert.equal(first.ok, true, first.message);

    const candidate = JSON.parse(JSON.stringify(records));
    candidate.objects.Inventory[1].availableQty = 99;
    const second = await tools.ontology_eval_run.execute(
      { packageId: 'retail.store-inventory', records: candidate },
      {}
    );
    assert.equal(second.ok, true, second.message);
    assert.equal(second.runs, 2);

    const cmp = await tools.ontology_eval_compare.execute({}, {});
    assert.equal(cmp.ok, true, cmp.message);
    assert.equal(cmp.comparison.comparable, true);
    const rendered = tools.ontology_eval_compare.output.render({}, cmp)[0].text;
    assert.ok(rendered.includes('数据变了'));
  });

  await it('只有一次运行时对比会说明还差几次', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontology-evals1-'));
    fs.copyFileSync(ASSET, path.join(dir, 'store-inventory.ir.json'));
    fs.copyFileSync(RECORDS, path.join(dir, 'store-inventory.records.json'));
    const mod = await import('../index.js');
    const registered = [];
    mod.apply(
      {
        tools: { register: (d) => { registered.push(d); return () => {}; } },
        effect: (run) => run(),
        inject: () => () => {},
        get: () => undefined,
        on: () => {},
        off: () => {},
      },
      { assetsDir: dir, trace: false, history: false, evalFile: path.join(dir, 'evals.jsonl') }
    );
    const tools = Object.fromEntries(registered.map((d) => [d.name, d]));
    await tools.ontology_eval_run.execute({ packageId: 'retail.store-inventory' }, {});
    const cmp = await tools.ontology_eval_compare.execute({}, {});
    assert.equal(cmp.ok, false);
    assert.ok(cmp.message.includes('只有 1 次'));
  });

  const total = pass + failures.length;
  console.log(`\n${pass}/${total} passed`);
  if (failures.length) {
    for (const f of failures) console.error('\n' + f.name + '\n', f.error);
    process.exit(1);
  }
})();
