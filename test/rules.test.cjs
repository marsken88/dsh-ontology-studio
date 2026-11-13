/**
 * Rule-expression and rule-evaluation tests.
 * Run `node test/rules.test.cjs`.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const IR = path.join(ROOT, 'assets', 'store-inventory.ir.json');
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

const FACTS = { availableQty: 80, safetyStock: 150, leadTime: 2, turnoverDays: 20, format: '标超', name: 'x' };

(async () => {
  const { parse, evaluate, evaluateExpression, identifiersOf, ParseError, UnknownIdentifierError } = await import(
    '../lib/expr.mjs'
  );
  const { resolveRule, evaluateRules } = await import('../lib/rules.mjs');

  console.log('\nexpr — 求值');

  await it('比较与逻辑', () => {
    assert.equal(evaluateExpression('availableQty < safetyStock', FACTS), true);
    assert.equal(evaluateExpression('availableQty <= 0', FACTS), false);
    assert.equal(evaluateExpression('availableQty < safetyStock && leadTime < 3', FACTS), true);
    assert.equal(evaluateExpression('availableQty < safetyStock && leadTime < 1', FACTS), false);
    assert.equal(evaluateExpression('availableQty > 500 || leadTime == 2', FACTS), true);
    assert.equal(evaluateExpression('!(availableQty > safetyStock)', FACTS), true);
  });

  await it('between 与算术', () => {
    assert.equal(evaluateExpression('turnoverDays between 12 and 35', FACTS), true);
    assert.equal(evaluateExpression('turnoverDays between 21 and 35', FACTS), false);
    assert.equal(evaluateExpression('availableQty + 70 == safetyStock', FACTS), true);
    assert.equal(evaluateExpression('safetyStock / 3 > availableQty / 2', FACTS), true);
    assert.equal(evaluateExpression('(availableQty + 10) * 2 == 180', FACTS), true);
  });

  await it('字符串与相等', () => {
    assert.equal(evaluateExpression('format == "标超"', FACTS), true);
    assert.equal(evaluateExpression("format != '便利店'", FACTS), true);
  });

  await it('未提供的标识符抛 UnknownIdentifierError', () => {
    assert.throws(() => evaluateExpression('onHandQty > 0', FACTS), UnknownIdentifierError);
  });

  await it('除零与空表达式被拒绝', () => {
    assert.throws(() => evaluateExpression('availableQty / 0 > 1', FACTS), RangeError);
    assert.throws(() => parse(''), ParseError);
    assert.throws(() => parse('   '), ParseError);
  });

  console.log('\nexpr — 语法拒绝（不能夹带代码）');

  await it('函数调用不被接受', () => {
    assert.throws(() => parse('system("rm -rf /")'), ParseError);
    assert.throws(() => parse('foo()'), ParseError);
  });

  await it('赋值、分号、花括号都被拒绝', () => {
    // 词法层就会被挡下（'=' 不在运算符表里），所以接受 ParseError 或 LexError
    for (const source of ['a = 1', 'a; b', '{a:1}']) {
      assert.throws(
        () => parse(source),
        (error) => error.name === 'ParseError' || error.name === 'LexError',
        source + ' 应当被拒绝'
      );
    }
  });

  await it('不完整的表达式被拒绝', () => {
    assert.throws(() => parse('availableQty <'), ParseError);
    assert.throws(() => parse('(availableQty'), ParseError);
    assert.throws(() => parse('turnoverDays between 12'), ParseError);
  });

  await it('保留字不能当标识符', () => {
    assert.throws(() => parse('between > 1'), ParseError);
  });

  await it('identifiersOf 去重并保持出现顺序', () => {
    const ast = parse('availableQty < safetyStock && availableQty > 0');
    assert.deepEqual(identifiersOf(ast), ['availableQty', 'safetyStock']);
  });

  console.log('\nrules — 归属推导');

  const ir = JSON.parse(fs.readFileSync(IR, 'utf8'));

  await it('按表达式引用的属性推导归属对象', () => {
    const rule = ir.rules.find((r) => r.id === 'inventory.lowStockWarning');
    const resolved = resolveRule(ir, rule);
    assert.equal(resolved.objectId, 'Inventory', resolved.reason);
    assert.deepEqual(resolved.identifiers.sort(), ['availableQty', 'safetyStock']);
  });

  await it('引用了不存在的属性时报告不可解析而不是默认通过', () => {
    const rule = ir.rules.find((r) => r.id === 'inventory.turnoverHealth');
    const resolved = resolveRule(ir, rule);
    assert.equal(resolved.objectId, undefined);
    assert.ok(resolved.reason.includes('turnoverDays'), resolved.reason);
  });

  await it('表达式写坏时报告解析错误', () => {
    const resolved = resolveRule(ir, { id: 'x.broken', name: 'x', expression: 'a <', severity: 'warn' });
    assert.ok(resolved.reason.includes('表达式无法解析'));
  });

  console.log('\nrules — 求值');

  const records = JSON.parse(fs.readFileSync(RECORDS, 'utf8'));

  await it('在示例数据上跑出真实的违规行', () => {
    const out = evaluateRules(ir, records);
    const low = out.results.find((r) => r.rule === 'inventory.lowStockWarning');
    assert.equal(low.object, 'Inventory');
    assert.equal(low.evaluated, 5);
    assert.deepEqual(low.violations.map((v) => v.row), [0, 1, 4]);
    assert.deepEqual(low.violations[0].values, { availableQty: 80, safetyStock: 150 });

    const stockout = out.results.find((r) => r.rule === 'inventory.stockoutAlert');
    assert.deepEqual(stockout.violations.map((v) => v.row), [1]);
  });

  await it('无违规的规则标记为 clean', () => {
    const out = evaluateRules(ir, records);
    const clean = evaluateRules(ir, {
      objects: { Inventory: [{ availableQty: 999, safetyStock: 10 }] },
    });
    assert.ok(out.results.every((r) => r.status === 'violations' || r.status === 'clean'));
    const stockout = clean.results.find((r) => r.rule === 'inventory.stockoutAlert');
    assert.equal(stockout.violations.length, 0);
    assert.equal(stockout.status, 'clean');
  });

  await it('汇总数字自洽', () => {
    const out = evaluateRules(ir, records);
    assert.equal(out.summary.rules, 4);
    assert.equal(out.summary.unresolved, 2, '两条规则引用不到对象');
    assert.equal(out.summary.violations, out.results.reduce((n, r) => n + r.violations.length, 0));
    assert.equal(out.summary.rows, 11);
  });

  await it('停用的规则仍求值但计入 disabled', () => {
    const withDisabled = JSON.parse(JSON.stringify(ir));
    withDisabled.rules[0].enabled = false;
    const out = evaluateRules(withDisabled, records);
    const rule = out.results.find((r) => r.rule === 'inventory.lowStockWarning');
    assert.equal(rule.enabled, false);
    assert.equal(out.summary.disabled, 1);
    assert.equal(out.summary.evaluated, out.summary.rules - out.summary.unresolved - 1);
  });

  await it('行内缺字段时记录为该行的错误，不中断整条规则', () => {
    const out = evaluateRules(ir, {
      objects: { Inventory: [{ availableQty: 1, safetyStock: 5 }, { availableQty: 9 }] },
    });
    const rule = out.results.find((r) => r.rule === 'inventory.lowStockWarning');
    assert.equal(rule.evaluated, 1);
    assert.equal(rule.errors, 1);
    assert.ok(rule.violations.some((v) => v.error && v.error.includes('safetyStock')));
  });

  await it('没有示例数据时所有规则都计入未求值', () => {
    const out = evaluateRules(ir, { objects: {} });
    assert.equal(out.summary.rows, 0);
    assert.ok(out.results.every((r) => r.evaluated === 0 && r.violations.length === 0));
  });

  const total = pass + failures.length;
  console.log(`\n${pass}/${total} passed`);
  if (failures.length) {
    for (const f of failures) console.error('\n' + f.name + '\n', f.error);
    process.exit(1);
  }
})();
