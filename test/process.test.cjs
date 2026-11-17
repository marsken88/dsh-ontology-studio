/**
 * 业务流程：声明校验 + 推演。
 *
 * 最想验的一条：动作步骤是在副本上**真的演算**的，所以后面的检查看到的是
 * 「如果前面执行了」的数据。做不到这点，推演就只是干看。
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
  const proc = await import('../lib/process.mjs');
  const { validateIr } = await import('../lib/ir.mjs');

  const ir = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'store-inventory.ir.json'), 'utf8'));
  const records = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'store-inventory.records.json'), 'utf8'));
  const clone = () => JSON.parse(JSON.stringify(ir));

  const example = ir.processes[0];

  console.log('\n声明校验');

  await it('随包示例流程通过整包校验', () => {
    assert.deepEqual(validateIr(clone()).problems, []);
  });

  await it('空步骤、坏类型、步骤 id 重复都被拒绝', () => {
    const bad = clone();
    bad.processes = [
      { id: 'a.b', name: 'A', steps: [] },
      { id: 'c.d', name: 'C', steps: [{ id: 's', kind: 'teleport' }] },
      { id: 'e.f', name: 'E', steps: [{ id: 's', kind: 'gate' }, { id: 's', kind: 'gate' }] },
    ];
    const codes = validateIr(bad).problems.map((p) => p.code);
    assert.ok(codes.includes('empty'));
    assert.ok(codes.includes('bad-enum'));
    assert.ok(codes.includes('duplicate'));
  });

  await it('检查步骤必须且只能指向规则或指标之一', () => {
    const bad = clone();
    bad.processes = [{ id: 'a.b', name: 'A', steps: [{ id: 's', kind: 'check' }] }];
    assert.ok(validateIr(bad).problems.some((p) => p.code === 'check-target'));

    bad.processes[0].steps[0] = { id: 's', kind: 'check', ruleId: 'nope.x', metricId: 'nope.y' };
    const codes = validateIr(bad).problems.map((p) => p.code);
    assert.ok(codes.includes('dangling-rule') && codes.includes('dangling-metric'));
  });

  await it('引用不存在的动作、或不可执行的动作都被拒绝', () => {
    const bad = clone();
    bad.processes = [
      { id: 'a.b', name: 'A', steps: [{ id: 's', kind: 'action', actionId: 'ghost' }] },
      { id: 'c.d', name: 'C', steps: [{ id: 's', kind: 'action', actionId: 'createReplenishment' }] },
    ];
    const codes = validateIr(bad).problems.map((p) => p.code);
    assert.ok(codes.includes('dangling-action'));
    assert.ok(codes.includes('not-executable'));
  });

  console.log('\n推演');

  await it('示例流程：检查通过 → 待人确认 → 会执行', () => {
    const plan = proc.planProcess(clone(), records, example);
    assert.equal(plan.ok, true);
    assert.equal(plan.canRun, true);
    assert.equal(plan.needsHuman, true);
    assert.equal(plan.blockedAt, null);
    const verdicts = plan.steps.map((s) => s.verdict);
    assert.deepEqual(verdicts, ['pass', 'manual', 'would-run']);
    assert.match(plan.steps[2].detail, /命中 1 行/);
  });

  await it('检查不通过就停在那一步，后面的步骤记为跳过', () => {
    const p = {
      id: 'a.b',
      name: 'A',
      steps: [
        { id: 'c1', kind: 'check', label: '不该缺货', metricId: 'inventory.stockoutCount', max: 0 },
        { id: 'a1', kind: 'action', actionId: 'adjustInventory', input: { storeId: 'S-0213', skuId: 'SKU-1002', availableQty: 60 } },
      ],
    };
    const plan = proc.planProcess(clone(), records, p);
    assert.equal(plan.canRun, false);
    assert.equal(plan.blockedAt, 0);
    assert.equal(plan.steps[0].verdict, 'fail');
    assert.equal(plan.steps[1].verdict, 'skipped');
  });

  await it('onFail: continue 时后面照常推演', () => {
    const p = {
      id: 'a.b',
      name: 'A',
      steps: [
        { id: 'c1', kind: 'check', metricId: 'inventory.stockoutCount', max: 0, onFail: 'continue' },
        { id: 'g1', kind: 'gate' },
      ],
    };
    const plan = proc.planProcess(clone(), records, p);
    assert.equal(plan.blockedAt, null);
    assert.equal(plan.steps[0].verdict, 'fail');
    assert.equal(plan.steps[1].verdict, 'manual');
  });

  await it('动作没有命中任何行时记为 no-match 并停下', () => {
    const p = {
      id: 'a.b',
      name: 'A',
      steps: [
        { id: 'a1', kind: 'action', actionId: 'adjustInventory', input: { storeId: 'NOPE', skuId: 'NOPE', availableQty: 1 } },
        { id: 'g1', kind: 'gate' },
      ],
    };
    const plan = proc.planProcess(clone(), records, p);
    assert.equal(plan.steps[0].verdict, 'no-match');
    assert.equal(plan.blockedAt, 0);
  });

  await it('动作是在副本上演算的：后面的检查看得到它的影响', () => {
    // 现在缺货 1 条；把本来有货的 S-0213/SKU-1001（80）改成 0，缺货应变 2 条
    const before = proc.planProcess(clone(), records, {
      id: 'a.b',
      name: 'A',
      steps: [{ id: 'c1', kind: 'check', metricId: 'inventory.stockoutCount', min: 2 }],
    });
    assert.equal(before.steps[0].verdict, 'fail', '执行前只有 1 条缺货，要求 ≥2 应不通过');

    const withAction = proc.planProcess(clone(), records, {
      id: 'c.d',
      name: 'C',
      steps: [
        { id: 'a1', kind: 'action', actionId: 'adjustInventory', input: { storeId: 'S-0213', skuId: 'SKU-1001', availableQty: 0 } },
        { id: 'c1', kind: 'check', metricId: 'inventory.stockoutCount', min: 2 },
      ],
    });
    assert.equal(withAction.steps[0].verdict, 'would-run');
    assert.equal(withAction.steps[1].verdict, 'pass', '推演应看到动作之后的缺货数');
    assert.equal(withAction.steps[1].value, 2);
  });

  await it('推演不改动传入的事实数据', () => {
    const snapshot = JSON.stringify(records);
    proc.planProcess(clone(), records, example);
    assert.equal(JSON.stringify(records), snapshot);
  });

  await it('声明有问题时直接说明，不硬推', () => {
    const plan = proc.planProcess(clone(), records, { id: 'x.y', name: 'X', steps: [{ id: 's', kind: 'check' }] });
    assert.equal(plan.ok, false);
    assert.match(plan.summary, /声明有问题/);
  });

  await it('describeProcess 把结构说成一行', () => {
    const line = proc.describeProcess(example);
    assert.match(line, /检查\(确认存在缺货\)/);
    assert.match(line, /人工确认\(店长确认补货量\)/);
    assert.match(line, /执行\(调整可售数量\)/);
  });

  await it('级联清理：动作没了就把那一步摘掉，空流程一并删掉', () => {
    const ir2 = clone();
    const touched = proc.trimProcessesAfterObjectDelete(ir2, { actions: ['adjustInventory'], metrics: ['inventory.stockoutCount'] });
    assert.deepEqual(touched, ['inventory.replenish']);
    assert.deepEqual(ir2.processes, [], '一步不剩的流程应当删除');
  });

  const total = pass + failures.length;
  console.log(`\n${pass}/${total} passed`);
  if (failures.length) {
    for (const f of failures) console.error('\n' + f.name + '\n', f.error);
    process.exit(1);
  }
})().catch((err) => {
  console.error('FAIL', err && err.stack);
  process.exit(1);
});
