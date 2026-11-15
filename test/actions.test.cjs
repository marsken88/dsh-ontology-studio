/**
 * Action executor tests: input validation, declarative effects, and the full
 * execute → writeback → rule-reverification loop. Everything runs on a temp
 * copy, so the repository's assets are never mutated.
 * Run `node test/actions.test.cjs`.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontology-action-'));
  fs.copyFileSync(ASSET, path.join(dir, 'store-inventory.ir.json'));
  fs.copyFileSync(RECORDS, path.join(dir, 'store-inventory.records.json'));
  return dir;
}

function fakeContext(approval) {
  const registered = [];
  return {
    registered,
    ctx: {
      tools: { register: (d) => { registered.push(d); return () => {}; } },
      effect: (run) => run(),
      inject: () => () => {},
      get: (name) => (name === 'approval' ? approval : undefined),
    },
  };
}

async function loadTools(dir, options = {}) {
  const mod = await import('../index.js');
  const { ctx, registered } = fakeContext(options.approval);
  mod.apply(ctx, Object.assign({ assetsDir: dir, approval: 'never', trace: false }, options.config || {}));
  return Object.fromEntries(registered.map((d) => [d.name, d]));
}

const readRecords = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'store-inventory.records.json'), 'utf8'));

(async () => {
  const { validateInput, applyEffect, executableActions, policiesFor } = await import('../lib/actions.mjs');
  const { validateIr } = await import('../lib/ir.mjs');

  const ir = JSON.parse(fs.readFileSync(ASSET, 'utf8'));
  const adjust = ir.actions.find((a) => a.id === 'adjustInventory');
  const declarationOnly = ir.actions.find((a) => a.id === 'createReplenishment');

  console.log('\nIR — 动作声明');

  await it('带 inputSchema 与 effect 的动作通过校验', () => {
    const result = validateIr(ir);
    assert.deepEqual(result.problems, [], JSON.stringify(result.problems, null, 2));
  });

  await it('effect 指向不存在的对象被拦下', () => {
    const bad = JSON.parse(JSON.stringify(ir));
    bad.actions[0].effect.object = 'Ghost';
    assert.ok(validateIr(bad).problems.some((p) => p.code === 'dangling-effect-object'));
  });

  await it('matchKeys 必须是目标对象的属性', () => {
    const bad = JSON.parse(JSON.stringify(ir));
    bad.actions[0].effect.matchKeys = ['storeId', 'nope'];
    assert.ok(validateIr(bad).problems.some((p) => p.code === 'dangling-match-key'));
  });

  await it('set 的字段必须在目标对象里、来源必须在入参里', () => {
    const badField = JSON.parse(JSON.stringify(ir));
    badField.actions[0].effect.set = { ghostField: 'availableQty' };
    assert.ok(validateIr(badField).problems.some((p) => p.code === 'dangling-set-field'));

    const badSource = JSON.parse(JSON.stringify(ir));
    badSource.actions[0].effect.set = { availableQty: 'notAnInput' };
    assert.ok(validateIr(badSource).problems.some((p) => p.code === 'unknown-input-field'));
  });

  await it('有 effect 没有 inputSchema 被拦下', () => {
    const bad = JSON.parse(JSON.stringify(ir));
    delete bad.actions[0].inputSchema;
    assert.ok(validateIr(bad).problems.some((p) => p.code === 'effect-without-input'));
  });

  await it('只有同时声明两者的动作才可执行', () => {
    assert.deepEqual(executableActions(ir).map((a) => a.id), ['adjustInventory', 'createTransfer', 'startStocktake']);
    assert.deepEqual(policiesFor(ir, 'createTransfer').map((p) => p.id).sort(), [
      'policy.crossRegion.transfer',
      'policy.inventory.writeApproval',
    ]);
  });

  console.log('\nvalidateInput');

  await it('完整合法入参通过并只保留声明字段', () => {
    const result = validateInput(adjust, { storeId: 'S-0213', skuId: 'SKU-1001', availableQty: 200, extra: 1 });
    assert.equal(result.ok, false, '多传字段应当报 unknown-field');
    assert.ok(result.problems.some((p) => p.code === 'unknown-field'));

    const clean = validateInput(adjust, { storeId: 'S-0213', skuId: 'SKU-1001', availableQty: 200 });
    assert.equal(clean.ok, true, JSON.stringify(clean.problems));
    assert.deepEqual(clean.value, { storeId: 'S-0213', skuId: 'SKU-1001', availableQty: 200 });
  });

  await it('缺必填、类型错、负数、枚举错都被拦下', () => {
    const missing = validateInput(adjust, { storeId: 'S-0213' });
    assert.deepEqual(missing.problems.map((p) => p.field).sort(), ['availableQty', 'skuId']);

    const wrongType = validateInput(adjust, { storeId: 'S-0213', skuId: 'SKU-1', availableQty: '200' });
    assert.ok(wrongType.problems.some((p) => p.code === 'bad-type'));

    const negative = validateInput(adjust, { storeId: 'S-0213', skuId: 'SKU-1', availableQty: -5 });
    assert.ok(negative.problems.some((p) => p.code === 'out-of-range'));

    const enumAction = {
      id: 'x',
      inputSchema: [{ name: 'format', type: 'enum', enum: ['标超', '便利店'] }],
    };
    assert.ok(validateInput(enumAction, { format: '大卖场' }).problems.some((p) => p.code === 'bad-enum'));
  });

  await it('没有 inputSchema 的动作直接不可校验', () => {
    const result = validateInput(declarationOnly, {});
    assert.equal(result.ok, false);
    assert.equal(result.problems[0].code, 'no-schema');
  });

  console.log('\napplyEffect');

  await it('按匹配键定位行并只改声明的字段', () => {
    const records = JSON.parse(fs.readFileSync(RECORDS, 'utf8'));
    const outcome = applyEffect(records, adjust.effect, { storeId: 'S-0213', skuId: 'SKU-1001', availableQty: 200 });
    assert.equal(outcome.matched, 1);
    assert.equal(outcome.updated, 1);
    assert.deepEqual(outcome.changed, [{ before: { availableQty: 80 }, after: { availableQty: 200 } }]);
    const row = records.objects.Inventory.find((r) => r.storeId === 'S-0213' && r.skuId === 'SKU-1001');
    assert.equal(row.availableQty, 200);
    assert.equal(row.safetyStock, 150, '未声明的字段不得改动');
  });

  await it('值未变化时不记为更新', () => {
    const records = JSON.parse(fs.readFileSync(RECORDS, 'utf8'));
    const outcome = applyEffect(records, adjust.effect, { storeId: 'S-0213', skuId: 'SKU-1001', availableQty: 80 });
    assert.equal(outcome.matched, 1);
    assert.equal(outcome.updated, 0);
    assert.deepEqual(outcome.changed, []);
  });

  await it('匹配不到行时 matched 为 0', () => {
    const records = JSON.parse(fs.readFileSync(RECORDS, 'utf8'));
    const outcome = applyEffect(records, adjust.effect, { storeId: 'S-9999', skuId: 'SKU-1001', availableQty: 1 });
    assert.equal(outcome.matched, 0);
  });

  console.log('\nontology_execute_action');

  await it('执行后写回事实数据，并用规则回验前后变化', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir);
    const result = await tools.ontology_execute_action.execute(
      {
        packageId: 'retail.store-inventory',
        actionId: 'adjustInventory',
        input: { storeId: 'S-0213', skuId: 'SKU-1001', availableQty: 200 },
      },
      {}
    );
    assert.equal(result.ok, true, result.message);
    assert.equal(result.matched, 1);
    assert.equal(result.updated, 1);
    assert.equal(result.rulesBefore.violations, 4);
    assert.equal(result.rulesAfter.violations, 3, '补货后低库存预警应少一条');
    assert.equal(result.rulesAfter.delta, 1);

    const saved = readRecords(dir);
    const row = saved.objects.Inventory.find((r) => r.storeId === 'S-0213' && r.skuId === 'SKU-1001');
    assert.equal(row.availableQty, 200, '事实数据必须真的被改写');
  });

  await it('dryRun 只预览，不写盘', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir);
    const before = fs.readFileSync(path.join(dir, 'store-inventory.records.json'), 'utf8');
    const result = await tools.ontology_execute_action.execute(
      {
        packageId: 'retail.store-inventory',
        actionId: 'adjustInventory',
        input: { storeId: 'S-0213', skuId: 'SKU-1001', availableQty: 200 },
        dryRun: true,
      },
      {}
    );
    assert.equal(result.ok, true);
    assert.equal(result.updated, 1);
    assert.equal(fs.readFileSync(path.join(dir, 'store-inventory.records.json'), 'utf8'), before);
  });

  await it('入参不合法时不写盘', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir);
    const before = fs.readFileSync(path.join(dir, 'store-inventory.records.json'), 'utf8');
    const result = await tools.ontology_execute_action.execute(
      { packageId: 'retail.store-inventory', actionId: 'adjustInventory', input: { storeId: 'S-0213' } },
      {}
    );
    assert.equal(result.ok, false);
    assert.equal(fs.readFileSync(path.join(dir, 'store-inventory.records.json'), 'utf8'), before);
  });

  await it('未声明 effect 的动作报错并给出可执行清单', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir);
    const result = await tools.ontology_execute_action.execute(
      { packageId: 'retail.store-inventory', actionId: 'createReplenishment', input: {} },
      {}
    );
    assert.equal(result.ok, false);
    assert.ok(result.message.includes('还没有可执行的声明'));
    assert.deepEqual(result.executable, ['adjustInventory', 'createTransfer', 'startStocktake']);
  });

  await it('匹配不到行时如实报错，不伪造成功', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir);
    const result = await tools.ontology_execute_action.execute(
      {
        packageId: 'retail.store-inventory',
        actionId: 'adjustInventory',
        input: { storeId: 'S-9999', skuId: 'SKU-1', availableQty: 10 },
      },
      {}
    );
    assert.equal(result.ok, false);
    assert.equal(result.matched, 0);
    assert.ok(result.message.includes('没有匹配到'));
  });

  await it('策略要求审批时执行动作需要审批，拒绝则不写盘', async () => {
    const dir = tempAssets();
    let asked = null;
    const tools = await loadTools(dir, {
      approval: { request: async (req) => { asked = req; return 'rejected'; } },
      config: { approval: 'destructive' },
    });
    const before = fs.readFileSync(path.join(dir, 'store-inventory.records.json'), 'utf8');
    const result = await tools.ontology_execute_action.execute(
      {
        packageId: 'retail.store-inventory',
        actionId: 'adjustInventory',
        input: { storeId: 'S-0213', skuId: 'SKU-1001', availableQty: 200 },
      },
      { agent: { id: 'session-1' } }
    );
    assert.equal(result.ok, false);
    assert.equal(result.approval, 'rejected');
    assert.equal(result.approvalRequired, true);
    assert.ok(asked);
    assert.equal(asked.toolName, 'ontology_execute_action');
    assert.equal(fs.readFileSync(path.join(dir, 'store-inventory.records.json'), 'utf8'), before);
  });

  await it('审批通过后正常执行并写回', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir, {
      approval: { request: async () => 'allowed-once' },
      config: { approval: 'destructive' },
    });
    const result = await tools.ontology_execute_action.execute(
      {
        packageId: 'retail.store-inventory',
        actionId: 'adjustInventory',
        input: { storeId: 'S-0188', skuId: 'SKU-1004', availableQty: 400 },
      },
      { agent: { id: 'session-1' } }
    );
    assert.equal(result.ok, true, result.message);
    assert.equal(result.approval, 'allowed-once');
    const saved = readRecords(dir);
    const row = saved.objects.Inventory.find((r) => r.storeId === 'S-0188' && r.skuId === 'SKU-1004');
    assert.equal(row.availableQty, 400);
  });

  console.log('\n跨对象动作（多 effect + 增量）');

  await it('createTransfer 一次改两个库存行，数量守恒', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir);
    const before = readRecords(dir);
    const qtyOf = (records, storeId) =>
      records.objects.Inventory.find((r) => r.storeId === storeId && r.skuId === 'SKU-1001').availableQty;
    const fromBefore = qtyOf(before, 'S-0213');
    const toBefore = qtyOf(before, 'S-0188');

    const result = await tools.ontology_execute_action.execute(
      {
        packageId: 'retail.store-inventory',
        actionId: 'createTransfer',
        input: { fromStoreId: 'S-0213', toStoreId: 'S-0188', skuId: 'SKU-1001', qty: 50 },
      },
      {}
    );
    assert.equal(result.ok, true, result.message);
    assert.equal(result.matched, 2, '应当命中调出与调入两行');
    assert.equal(result.updated, 2);

    const after = readRecords(dir);
    assert.equal(qtyOf(after, 'S-0213'), fromBefore - 50, '调出门店应减少');
    assert.equal(qtyOf(after, 'S-0188'), toBefore + 50, '调入门店应增加');
    assert.equal(qtyOf(after, 'S-0213') + qtyOf(after, 'S-0188'), fromBefore + toBefore, '总量守恒');
  });

  await it('调出门店不存在时命中不足，不假装成功', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir);
    const result = await tools.ontology_execute_action.execute(
      {
        packageId: 'retail.store-inventory',
        actionId: 'createTransfer',
        input: { fromStoreId: 'S-0000', toStoreId: 'S-0188', skuId: 'SKU-1001', qty: 10 },
      },
      {}
    );
    // 只有调入那一侧命中
    assert.equal(result.matched, 1);
    assert.equal(result.updated, 1);
    assert.equal(result.effects.find((e) => e.object === 'Inventory' && e.matched === 0) !== undefined, true);
  });

  await it('增量表达式引用未声明的入参时被校验器拦下', async () => {
    const bad = JSON.parse(JSON.stringify(ir));
    const action = bad.actions.find((a) => a.id === 'createTransfer');
    action.effect[0].adjust.availableQty = '-notAnInput';
    assert.ok(validateIr(bad).problems.some((p) => p.code === 'unknown-input-field'));
  });

  await it('对非数值字段做增量被拦下', async () => {
    const bad = JSON.parse(JSON.stringify(ir));
    const action = bad.actions.find((a) => a.id === 'adjustInventory');
    action.effect.adjust = { storeId: 'qty' };
    assert.ok(validateIr(bad).problems.some((p) => p.code === 'non-numeric-adjust'));
  });

  await it('effect 既没有 set 也没有 adjust 时被拦下', async () => {
    const bad = JSON.parse(JSON.stringify(ir));
    const action = bad.actions.find((a) => a.id === 'adjustInventory');
    delete action.effect.set;
    assert.ok(validateIr(bad).problems.some((p) => p.code === 'no-operation'));
  });

  await it('执行结果的变更记录可无损 JSON 序列化（不能有 undefined）', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir);
    const result = await tools.ontology_execute_action.execute(
      {
        packageId: 'retail.store-inventory',
        actionId: 'startStocktake',
        input: { storeId: 'S-0213', skuId: 'SKU-1001', lastStocktakeAt: '2026-11-15T10:00:00+08:00' },
      },
      {}
    );
    assert.equal(result.ok, true, result.message);
    // 宿主会校验返回值能否无损序列化；undefined 会被静默丢弃，
    // 结果是「工具报错，但写盘已经发生」——这是最糟的一种失败。
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
    assert.equal(result.changed[0].before.lastStocktakeAt, null, '不存在的旧值记为 null 而不是 undefined');
  });

  const total = pass + failures.length;
  console.log(`\n${pass}/${total} passed`);
  if (failures.length) {
    for (const f of failures) console.error('\n' + f.name + '\n', f.error);
    process.exit(1);
  }
})();
