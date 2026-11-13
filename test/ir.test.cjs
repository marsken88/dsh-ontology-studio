/**
 * IR validator + registry tests. No framework: run `node test/ir.test.cjs`.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
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

function codes(result) {
  return result.problems.map((p) => p.code);
}

function clone() {
  return JSON.parse(fs.readFileSync(ASSET, 'utf8'));
}

(async () => {
  const { validateIr, summarizeIr, impactOf, crossPackageProblems } = await import(
    '../lib/ir.mjs'
  );
  const { createStore } = await import('../lib/store.mjs');

  console.log('\nvalidateIr');

  await it('随包发布的 IR 通过校验', () => {
    const result = validateIr(clone());
    assert.deepEqual(result.problems, [], JSON.stringify(result.problems, null, 2));
    assert.equal(result.ok, true);
  });

  await it('非对象输入直接失败', () => {
    assert.equal(validateIr(null).ok, false);
    assert.equal(validateIr([]).ok, false);
  });

  await it('坏版本号被拦下', () => {
    const ir = clone();
    ir.version = 'v1';
    assert.ok(codes(validateIr(ir)).includes('bad-version'));
  });

  await it('坏包 id 被拦下', () => {
    const ir = clone();
    ir.id = 'StoreInventory';
    assert.ok(codes(validateIr(ir)).includes('bad-id'));
  });

  await it('重复对象 id 被拦下', () => {
    const ir = clone();
    ir.objects.push(JSON.parse(JSON.stringify(ir.objects[0])));
    assert.ok(codes(validateIr(ir)).includes('duplicate'));
  });

  await it('主键指向不存在的属性被拦下', () => {
    const ir = clone();
    ir.objects[2].keys = ['storeId', 'notAProperty'];
    const result = validateIr(ir);
    assert.ok(codes(result).includes('dangling-key'), JSON.stringify(result.problems));
  });

  await it('关系端点不存在被拦下', () => {
    const ir = clone();
    ir.links[0].target = 'Ghost';
    assert.ok(codes(validateIr(ir)).includes('dangling-endpoint'));
  });

  await it('关系基数非法被拦下', () => {
    const ir = clone();
    ir.links[0].cardinality = 'many';
    assert.ok(codes(validateIr(ir)).includes('bad-enum'));
  });

  await it('动作写入不存在对象被拦下', () => {
    const ir = clone();
    ir.actions[0].writes = ['Inventory', 'Nope'];
    assert.ok(codes(validateIr(ir)).includes('dangling-write'));
  });

  await it('approvalRequired 必须显式声明', () => {
    const ir = clone();
    delete ir.actions[0].approvalRequired;
    assert.ok(codes(validateIr(ir)).includes('bad-type'));
  });

  await it('策略指向不存在动作被拦下', () => {
    const ir = clone();
    ir.policies[0].appliesTo = ['ghostAction'];
    assert.ok(codes(validateIr(ir)).includes('dangling-target'));
  });

  await it('enum 属性必须有取值，非 enum 不得有', () => {
    const ir = clone();
    ir.objects[0].properties[3].enum = [];
    assert.ok(codes(validateIr(ir)).includes('missing'));
    const ir2 = clone();
    ir2.objects[0].properties[0].enum = ['a'];
    assert.ok(codes(validateIr(ir2)).includes('unexpected'));
  });

  await it('属性名重复被拦下', () => {
    const ir = clone();
    ir.objects[0].properties.push({ name: 'storeId', type: 'string' });
    assert.ok(codes(validateIr(ir)).includes('duplicate'));
  });

  await it('对象为空的本体包被拦下', () => {
    const ir = clone();
    ir.objects = [];
    assert.ok(codes(validateIr(ir)).includes('empty'));
  });

  console.log('\nsummarizeIr');

  await it('统计与资产内容一致', () => {
    const s = summarizeIr(clone());
    assert.equal(s.objects, 6);
    assert.equal(s.links, 5);
    assert.equal(s.rules, 4);
    assert.equal(s.actions, 4);
    assert.equal(s.policies, 2);
    assert.equal(s.status, 'published');
  });

  console.log('\nimpactOf');

  await it('Inventory 的影响面被正确识别', () => {
    const impact = impactOf(clone(), 'Inventory');
    assert.ok(impact, '应返回影响分析');
    assert.equal(impact.object.id, 'Inventory');
    assert.deepEqual(impact.outgoingLinks.map((l) => l.target).sort(), ['Product', 'Store']);
    assert.deepEqual(impact.incomingLinks, []);
    assert.deepEqual(impact.actions.map((a) => a.id).sort(), ['adjustInventory', 'createTransfer', 'startStocktake']);
    assert.deepEqual(impact.policies.map((p) => p.id).sort(), [
      'policy.crossRegion.transfer',
      'policy.inventory.writeApproval',
    ]);
    assert.equal(impact.rules.length, 3, '应命中引用 availableQty / safetyStock 的 3 条规则');
    assert.equal(impact.dependents, 0 + 3 + 3);
  });

  await it('关系 id 的 snake_case 规则生效', () => {
    const ir = clone();
    ir.links[0].id = 'inventoryBelongsToStore';
    assert.ok(codes(validateIr(ir)).includes('bad-id'));
  });

  await it('Store 的入向关系被正确识别', () => {
    const impact = impactOf(clone(), 'Store');
    assert.deepEqual(impact.incomingLinks.map((l) => l.source).sort(), ['Inventory', 'Member']);
  });

  await it('不存在的对象返回 null', () => {
    assert.equal(impactOf(clone(), 'Ghost'), null);
  });

  console.log('\ncrossPackageProblems');

  await it('重复包 id 被识别', () => {
    const ir = clone();
    const problems = crossPackageProblems([
      { file: 'a.ir.json', ir },
      { file: 'b.ir.json', ir },
    ]);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].code, 'duplicate-package');
  });

  console.log('\nstore');

  await it('能读出随包资产并通过校验', async () => {
    const store = createStore({ dir: path.join(ROOT, 'assets') });
    const { dir, entries } = await store.list();
    assert.ok(dir.endsWith('assets'));
    assert.equal(entries.length, 1, JSON.stringify(entries.map((e) => e.file)));
    assert.equal(entries[0].ir.id, 'retail.store-inventory');
    assert.equal(entries[0].ok, true);
    assert.equal(entries[0].summary.objects, 6);
  });

  await it('按包 id 能取回单个资产包', async () => {
    const store = createStore({ dir: path.join(ROOT, 'assets') });
    const { entry } = await store.get('retail.store-inventory');
    assert.ok(entry);
    assert.equal(entry.ir.name, '门店-商品-库存');
  });

  await it('不存在的目录不抛错', async () => {
    const store = createStore({ dir: path.join(ROOT, 'assets', 'does-not-exist') });
    const { entries, missingDir } = await store.list();
    assert.deepEqual(entries, []);
    assert.equal(missingDir, true);
  });

  const total = pass + failures.length;
  console.log(`\n${pass}/${total} passed`);
  if (failures.length) {
    for (const f of failures) console.error('\n' + f.name + '\n', f.error);
    process.exit(1);
  }
})();
