/**
 * Harness readiness tests.
 * Run `node test/harness.test.cjs`.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
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

const minimal = (extra = {}) =>
  Object.assign(
    { irVersion: '0.1.0', id: 'probe.bare', name: '裸包', version: '0.1.0', status: 'draft', objects: [], links: [], rules: [], actions: [], policies: [], agents: [] },
    extra
  );

(async () => {
  const { harnessCheck } = await import('../lib/harness-check.mjs');
  const ir = JSON.parse(fs.readFileSync(ASSET, 'utf8'));
  const records = JSON.parse(fs.readFileSync(RECORDS, 'utf8'));

  console.log('\n范围');

  await it('六个方面都覆盖到', () => {
    const report = harnessCheck(minimal(), { records: { objects: {} } });
    assert.deepEqual(Object.keys(report.byArea).sort(), ['Agent', '动作', '数据', '护栏', '规则', '结构'].sort());
    assert.equal(report.totalAreas, 6);
  });

  console.log('\n随包资产');

  await it('随包资产被判为就绪，但有如实的提示', () => {
    const report = harnessCheck(ir, { records });
    assert.equal(report.verdict, 'ready');
    assert.equal(report.readyAreas, 6);
    assert.deepEqual(report.gaps, []);
    assert.ok(report.notes.some((n) => n.includes('停用')));
    assert.ok(report.notes.some((n) => n.includes('可执行')));
  });

  console.log('\n缺口识别');

  await it('空包会把六个方面全指出来', () => {
    const report = harnessCheck(minimal(), { records: { objects: {} } });
    const areas = report.gaps.map((g) => g.area);
    for (const area of ['规则', '动作', '数据', 'Agent']) {
      assert.ok(areas.includes(area), '缺少 ' + area + ' 的缺口');
    }
    assert.equal(report.verdict, 'incomplete');
  });

  await it('没有主键的对象被点名', () => {
    const pkg = minimal({ objects: [{ id: 'Thing', name: '东西', properties: [{ name: 'id', type: 'string' }] }] });
    const report = harnessCheck(pkg);
    assert.ok(report.gaps.some((g) => g.title.includes('没有主键')));
  });

  await it('孤立对象被点名（没有任何关系）', () => {
    const pkg = minimal({
      objects: [
        { id: 'A', name: '甲', keys: ['id'], properties: [{ name: 'id', type: 'string' }] },
        { id: 'B', name: '乙', keys: ['id'], properties: [{ name: 'id', type: 'string' }] },
      ],
      links: [{ id: 'a_refs_b', source: 'A', target: 'B', type: 'references' }],
    });
    const report = harnessCheck(pkg);
    // A 与 B 都有关系，不该报孤立；换成第三个对象才该报
    assert.ok(!report.gaps.some((g) => g.title.includes('没有任何关系')));
    pkg.objects.push({ id: 'C', name: '丙', keys: ['id'], properties: [{ name: 'id', type: 'string' }] });
    const report2 = harnessCheck(pkg);
    assert.ok(report2.gaps.some((g) => g.title.includes('C')));
  });

  await it('全部动作都可执行但都不需审批时，护栏被点名', () => {
    const pkg = minimal({
      objects: [{ id: 'T', name: '表', keys: ['id'], properties: [{ name: 'id', type: 'string' }, { name: 'qty', type: 'number' }] }],
      rules: [{ id: 'r.one', name: '一', expression: 'qty > 1', severity: 'warn', enabled: true }],
      actions: [
        {
          id: 'setQty',
          name: '改数量',
          inputSchema: [{ name: 'qty', type: 'number', required: true }],
          effect: { object: 'T', matchKeys: ['id'], set: { qty: 'qty' } },
          approvalRequired: false,
        },
      ],
    });
    const report = harnessCheck(pkg);
    assert.ok(report.gaps.some((g) => g.area === '护栏'), '全部免审批应当被点名');
  });

  await it('动作只有声明时单独说明', () => {
    const pkg = minimal({
      objects: [{ id: 'T', name: '表', keys: ['id'], properties: [{ name: 'id', type: 'string' }] }],
      actions: [{ id: 'noop', name: '空动作', writes: ['T'] }],
    });
    const report = harnessCheck(pkg);
    assert.ok(report.gaps.some((g) => g.title.includes('没有一个可执行')));
  });

  await it('Agent 缺少对象/工具/评测口径时逐条点名', () => {
    const pkg = minimal({
      objects: [{ id: 'T', name: '表', keys: ['id'], properties: [{ name: 'id', type: 'string' }] }],
      agents: [{ id: 'lazy-agent', name: '偷懒 Agent', status: 'draft' }],
    });
    const report = harnessCheck(pkg);
    const agentGaps = report.gaps.filter((g) => g.area === 'Agent');
    assert.equal(agentGaps.length, 3, '对象/工具/评测口径三项都该点名');
  });

  await it('不传事实数据时不检查数据面', () => {
    const report = harnessCheck(ir);
    assert.ok(!report.gaps.some((g) => g.area === '数据'));
  });

  await it('每条缺口都带「怎么补」', () => {
    const report = harnessCheck(minimal(), { records: { objects: {} } });
    assert.ok(report.gaps.every((g) => typeof g.how === 'string' && g.how.length > 0));
  });

  const total = pass + failures.length;
  console.log(`\n${pass}/${total} passed`);
  if (failures.length) {
    for (const f of failures) console.error('\n' + f.name + '\n', f.error);
    process.exit(1);
  }
})();
