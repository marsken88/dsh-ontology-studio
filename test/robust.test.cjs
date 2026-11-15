/**
 * Robustness tests: packages the happy path never sees.
 * Run `node test/robust.test.cjs`.
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

const minimal = (extra = {}) =>
  Object.assign(
    { irVersion: '0.1.0', id: 'probe.minimal', name: '最小包', version: '0.1.0', status: 'draft', objects: [], links: [], rules: [], actions: [], policies: [] },
    extra
  );

(async () => {
  const { validateIr } = await import('../lib/ir.mjs');
  const { buildBrief } = await import('../lib/context.mjs');
  const { generateAppSpec } = await import('../lib/app.mjs');
  const { ruleWarnings, evaluateRules } = await import('../lib/rules.mjs');
  const { markdownDoc, packageSchemas } = await import('../lib/export.mjs');

  console.log('\n空与退化输入');

  await it('空资产包：校验、简报、应用规格、导出都不崩', () => {
    const empty = minimal();
    assert.equal(validateIr(empty).ok, false, '空包本身应被校验拦下');
    assert.ok(buildBrief(empty, { maxChars: 500 }).length > 0);
    assert.equal(generateAppSpec(empty).pageCount, 0);
    assert.equal(markdownDoc(empty).length > 0, true);
    assert.deepEqual(Object.keys(packageSchemas(empty)['$defs'] || {}), [], '空包导出的 $defs 应为空');
    assert.equal(evaluateRules(empty, {}).summary.rules, 0);
  });

  await it('没有属性的对象被校验报出，页面也不崩', () => {
    const hollow = minimal({ objects: [{ id: 'Ghost', name: '空对象', properties: [] }] });
    assert.ok(validateIr(hollow).problems.length > 0);
    const page = generateAppSpec(hollow).pages[0];
    assert.deepEqual(page.columns, []);
    assert.deepEqual(page.detailFields, []);
  });

  await it('表情与中文能贯穿简报、页面与导出', () => {
    const unicode = minimal({
      objects: [{ id: 'Emoji', name: '表情😀对象', keys: ['id'], properties: [{ name: 'id', type: 'string', required: true, label: '标识🆔' }] }],
    });
    assert.ok(buildBrief(unicode, { maxChars: 500 }).includes('表情😀对象'));
    assert.ok(markdownDoc(unicode).includes('表情😀对象'));
    assert.equal(generateAppSpec(unicode).pages[0].columns[0].label, '标识🆔');
  });

  console.log('\n简报的字符上限');

  await it('无论多大，简报都不超过上限（截断标记也算在里面）', () => {
    const big = minimal({
      objects: Array.from({ length: 300 }, (_, i) => ({
        id: 'Obj' + i,
        name: '对象' + i,
        keys: ['id'],
        properties: [{ name: 'id', type: 'string', required: true }],
      })),
    });
    for (const cap of [400, 800, 2000, 5000]) {
      const text = buildBrief(big, { maxChars: cap, level: 'full' });
      assert.ok(text.length <= cap, `cap ${cap} 实际 ${text.length}`);
    }
  });

  await it('被截断时带说明，不静默丢内容', () => {
    const big = minimal({
      objects: Array.from({ length: 200 }, (_, i) => ({ id: 'O' + i, name: '对象' + i, properties: [{ name: 'id', type: 'string' }] })),
    });
    const text = buildBrief(big, { maxChars: 400, level: 'full' });
    assert.ok(text.includes('已截断'), '应当明确说明被截断');
  });

  console.log('\n永远不会触发的规则');

  await it('引用不存在属性的规则被列出来', () => {
    const pkg = JSON.parse(fs.readFileSync(ASSET, 'utf8'));
    const warnings = ruleWarnings(pkg);
    const rules = warnings.map((w) => w.rule);
    assert.ok(rules.includes('inventory.turnoverHealth'), 'turnoverDays 不存在，应被点名');
    assert.ok(rules.includes('inventory.autoReplenish'), 'leadTime 不存在，应被点名');
    assert.ok(warnings.find((w) => w.rule === 'inventory.autoReplenish').message.includes('已停用'));
  });

  await it('能解析的规则不产生告警', () => {
    const pkg = JSON.parse(fs.readFileSync(ASSET, 'utf8'));
    const warnings = ruleWarnings(pkg).map((w) => w.rule);
    assert.ok(!warnings.includes('inventory.lowStockWarning'));
    assert.ok(!warnings.includes('inventory.stockoutAlert'));
  });

  await it('表达式写坏的规则既告警也如实跳过', () => {
    const pkg = minimal({
      objects: [{ id: 'Thing', name: '东西', keys: ['id'], properties: [{ name: 'id', type: 'string', required: true }] }],
      rules: [{ id: 'bad', name: '坏', expression: 'qty >', severity: 'warn', enabled: true }],
    });
    const warnings = ruleWarnings(pkg);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].message.includes('无法解析'));
    assert.deepEqual(evaluateRules(pkg, {}).skipped.map((s) => s.rule), ['bad']);
  });

  await it('没写表达式的规则也告警', () => {
    const pkg = minimal({ rules: [{ id: 'noexpr', name: '空', severity: 'warn' }] });
    assert.equal(ruleWarnings(pkg)[0].code, 'rule-no-expression');
  });

  console.log('\n工具层');

  await it('ontology_validate 把告警作为建议返回，不影响 ok', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontology-robust-'));
    fs.copyFileSync(ASSET, path.join(dir, 'store-inventory.ir.json'));
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
      { assetsDir: dir, trace: false }
    );
    const tool = registered.find((d) => d.name === 'ontology_validate');
    const value = await tool.execute({}, {});
    assert.equal(value.ok, true, '有告警不应让校验失败');
    assert.equal(value.warnings.length, 2);
    const rendered = tool.output.render({}, value)[0].text;
    assert.ok(rendered.includes('永远不会触发'));
    assert.ok(rendered.includes('turnoverDays'));
  });

  const total = pass + failures.length;
  console.log(`\n${pass}/${total} passed`);
  if (failures.length) {
    for (const f of failures) console.error('\n' + f.name + '\n', f.error);
    process.exit(1);
  }
})();
