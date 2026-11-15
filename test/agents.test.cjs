/**
 * Agent roster tests: declaration in the IR, evidence from the trace.
 * Run `node test/agents.test.cjs`.
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

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontology-agents-'));
  fs.copyFileSync(ASSET, path.join(dir, 'store-inventory.ir.json'));
  fs.copyFileSync(RECORDS, path.join(dir, 'store-inventory.records.json'));
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
    approval: 'never',
    traceFile: path.join(dir, 'trace.jsonl'),
    historyFile: path.join(dir, 'history.jsonl'),
  });
  return { dir, tools: Object.fromEntries(registered.map((d) => [d.name, d])) };
}

(async () => {
  const { validateIr } = await import('../lib/ir.mjs');
  const ir = JSON.parse(fs.readFileSync(ASSET, 'utf8'));

  console.log('\n声明校验');

  await it('随包资产里的两个 Agent 通过校验', () => {
    const result = validateIr(ir);
    assert.deepEqual(result.problems, [], JSON.stringify(result.problems, null, 2));
    assert.equal(ir.agents.length, 2);
  });

  await it('引用了不存在的对象或动作被拦下', () => {
    const bad = JSON.parse(JSON.stringify(ir));
    bad.agents[0].usesObjects = ['Ghost'];
    bad.agents[0].actions = ['ghostAction'];
    const codes = validateIr(bad).problems.map((p) => p.code);
    assert.ok(codes.includes('dangling-object'));
    assert.ok(codes.includes('dangling-action'));
  });

  await it('agent id 必须是 kebab-case，且不能重复', () => {
    const bad = JSON.parse(JSON.stringify(ir));
    bad.agents[0].id = 'Stock_Replenisher';
    assert.ok(validateIr(bad).problems.some((p) => p.code === 'bad-id'));

    const dup = JSON.parse(JSON.stringify(ir));
    dup.agents[1].id = dup.agents[0].id;
    assert.ok(validateIr(dup).problems.some((p) => p.code === 'duplicate'));
  });

  await it('agent 的未知字段被拦下', () => {
    const bad = JSON.parse(JSON.stringify(ir));
    bad.agents[0].evals = 'x';
    assert.ok(validateIr(bad).problems.some((p) => p.code === 'unknown-key'));
  });

  console.log('\n工具：声明 + 证据');

  await it('轨迹里没有调用时如实说明', async () => {
    const { tools } = await setup();
    const result = await tools.ontology_agents.execute({ packageId: 'retail.store-inventory' }, {});
    assert.equal(result.ok, true);
    assert.equal(result.agents.length, 2);
    const rendered = tools.ontology_agents.output.render({}, result)[0].text;
    assert.ok(rendered.includes('轨迹里没有这个 Agent 的调用'));
  });

  await it('调用能按 agent 归属，未声明的会话计入 unattributed', async () => {
    const { tools } = await setup();
    await tools.ontology_get.execute({ packageId: 'retail.store-inventory' }, { agent: { id: 'stock-replenisher' } });
    await tools.ontology_evaluate_rules.execute({ packageId: 'retail.store-inventory' }, { agent: { id: 'stock-replenisher' } });
    await tools.ontology_list.execute({}, { agent: { id: 'someone-else' } });

    const result = await tools.ontology_agents.execute({ packageId: 'retail.store-inventory' }, {});
    const use = result.usage.byTool['stock-replenisher'];
    assert.equal(use.ontology_get.ok, 1);
    assert.equal(use.ontology_evaluate_rules.ok, 1);
    assert.equal(result.usage.unattributed, 1);
  });

  await it('失败的调用按 fail 计数', async () => {
    const { tools } = await setup();
    await tools.ontology_get.execute({ packageId: 'nope' }, { agent: { id: 'store-inspector' } });
    const result = await tools.ontology_agents.execute({ packageId: 'retail.store-inventory' }, {});
    const use = result.usage.byTool['store-inspector'];
    assert.equal(use.ontology_get.fail, 1);
    assert.equal(use.ontology_get.ok, 0);
  });

  await it('没有调用时不产生空的分组', async () => {
    const { tools } = await setup();
    await tools.ontology_get.execute({ packageId: 'retail.store-inventory' }, { agent: { id: 'store-inspector' } });
    const result = await tools.ontology_agents.execute({ packageId: 'retail.store-inventory' }, {});
    assert.equal(result.usage.byTool['stock-replenisher'], undefined);
  });

  await it('未知资产包报错', async () => {
    const { tools } = await setup();
    const result = await tools.ontology_agents.execute({ packageId: 'nope' }, {});
    assert.equal(result.ok, false);
    assert.ok(result.message.includes('nope'));
  });

  const total = pass + failures.length;
  console.log(`\n${pass}/${total} passed`);
  if (failures.length) {
    for (const f of failures) console.error('\n' + f.name + '\n', f.error);
    process.exit(1);
  }
})();
