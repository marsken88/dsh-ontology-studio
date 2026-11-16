/**
 * 指标口径：声明式聚合在事实数据上真的算。
 *
 * 重点验「空」与「零」分得开：
 *   过滤没命中 → count = 0，参与 0 / 总数 N
 *   对象一行都没有 → value = null，参与 0 / 总数 0
 * 这两个如果都显示 0，一张空表会被读成业绩归零。
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
  const metrics = await import('../lib/metrics.mjs');
  const { validateIr } = await import('../lib/ir.mjs');

  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'store-inventory.ir.json'), 'utf8'));
  const clone = () => JSON.parse(JSON.stringify(base));
  const records = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'store-inventory.records.json'), 'utf8'));

  const metric = (patch) =>
    Object.assign({ id: 'inventory.probe', name: '探针', object: 'Inventory', aggregation: 'count' }, patch);

  console.log('\n校验');

  await it('合法口径通过整包校验', () => {
    const ir = clone();
    ir.metrics = [metric({ filter: 'availableQty <= 0' })];
    assert.deepEqual(validateIr(ir).problems, []);
  });

  await it('指向不存在的对象/属性、非法聚合、坏表达式都被拒绝', () => {
    const ir = clone();
    ir.metrics = [
      metric({ id: 'a.b', object: 'Nope' }),
      metric({ id: 'c.d', field: 'ghost', aggregation: 'sum' }),
      metric({ id: 'e.f', aggregation: 'median' }),
      metric({ id: 'g.h', filter: 'availableQty <' }),
    ];
    const codes = validateIr(ir).problems.map((p) => p.code);
    assert.ok(codes.includes('dangling-object'));
    assert.ok(codes.includes('dangling-field'));
    assert.ok(codes.includes('bad-enum'));
    assert.ok(codes.includes('bad-expression'));
  });

  await it('对非数值属性求和无意义，直接拒绝', () => {
    const ir = clone();
    ir.metrics = [metric({ object: 'Store', aggregation: 'sum', field: 'storeName' })];
    const problems = validateIr(ir).problems;
    assert.ok(problems.some((p) => p.code === 'non-numeric'));
  });

  await it('过滤表达式引用了该对象没有的属性也会被拒绝', () => {
    const ir = clone();
    ir.metrics = [metric({ filter: 'costPrice > 3' })];
    assert.ok(validateIr(ir).problems.some((p) => p.code === 'dangling-identifier'));
  });

  console.log('\n计算');

  await it('count 不带字段 = 行数', () => {
    const r = metrics.computeMetric(clone(), records, metric({ aggregation: 'count' }));
    assert.equal(r.value, 5);
    assert.equal(r.matched, 5);
    assert.equal(r.total, 5);
  });

  await it('count 带过滤 = 命中的行数，且说清参与了几行', () => {
    const r = metrics.computeMetric(clone(), records, metric({ aggregation: 'count', filter: 'availableQty <= 0' }));
    assert.equal(r.value, 1);
    assert.equal(r.matched, 1);
    assert.equal(r.total, 5);
  });

  await it('sum / avg / min / max 对数值字段', () => {
    const ir = clone();
    const sums = metrics.computeMetric(ir, records, metric({ aggregation: 'sum', field: 'availableQty' }));
    assert.equal(sums.value, 653);
    const avg = metrics.computeMetric(ir, records, metric({ aggregation: 'avg', field: 'availableQty' }));
    assert.ok(avg.value > 0 && avg.value < 653);
    const min = metrics.computeMetric(ir, records, metric({ aggregation: 'min', field: 'availableQty' }));
    const max = metrics.computeMetric(ir, records, metric({ aggregation: 'max', field: 'availableQty' }));
    assert.ok(min.value <= max.value);
    assert.equal(min.matched, 5);
  });

  await it('过滤没命中 ≠ 对象没数据：前者 count 0 / 参与 0，后者 value 为 null', () => {
    const ir = clone();
    const noHit = metrics.computeMetric(
      ir,
      records,
      metric({ aggregation: 'count', filter: 'availableQty > 9999' })
    );
    assert.equal(noHit.value, 0);
    assert.equal(noHit.matched, 0);
    assert.equal(noHit.total, 5);

    const emptyRecords = { objects: {} };
    const noRows = metrics.computeMetric(ir, emptyRecords, metric({ aggregation: 'sum', field: 'availableQty' }));
    assert.equal(noRows.value, null);
    assert.equal(noRows.total, 0);
  });

  await it('算不出来的口径返回 problems，不抛错', () => {
    const r = metrics.computeMetric(clone(), records, metric({ object: 'Nope' }));
    assert.equal(r.ok, false);
    assert.equal(r.value, null);
    assert.ok(r.problems.length);
  });

  await it('空值不参与数值聚合', () => {
    const ir = clone();
    const recs = { objects: { Inventory: [{ storeId: 'a', availableQty: 10 }, { storeId: 'b', availableQty: null }, { storeId: 'c' }] } };
    const r = metrics.computeMetric(ir, recs, metric({ aggregation: 'avg', field: 'availableQty' }));
    assert.equal(r.value, 10);
    assert.equal(r.matched, 3, '三行都参与了过滤，但只有一行有数值');
  });

  console.log('\n描述');

  await it('describeMetric 说清对象/字段/聚合/过滤', () => {
    assert.equal(metrics.describeMetric(metric({ aggregation: 'sum', field: 'availableQty' })), 'Inventory.availableQty 求和');
    assert.match(metrics.describeMetric(metric({ filter: 'availableQty <= 0' })), /仅统计 availableQty <= 0 的行/);
  });

  await it('describeResult 带参与行数，空值显示「—」而不是 0', () => {
    const ir = clone();
    const r = metrics.computeMetric(ir, records, metric({ aggregation: 'sum', field: 'availableQty' }));
    assert.match(metrics.describeResult(r), /653（5\/5 行参与计算）/);
    const empty = metrics.computeMetric(ir, { objects: {} }, metric({ aggregation: 'sum', field: 'availableQty' }));
    assert.match(metrics.describeResult(empty), /—（0 行参与计算/);
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
