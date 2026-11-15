/**
 * Team-convention lint tests: config-driven, advisory only.
 * Run `node test/lint.test.cjs`.
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

(async () => {
  const { applyLint } = await import('../lib/lint.mjs');
  const ir = JSON.parse(fs.readFileSync(ASSET, 'utf8'));

  console.log('\napplyLint');

  await it('没有规则时不产生任何问题', () => {
    assert.deepEqual(applyLint(ir, []), []);
    assert.deepEqual(applyLint(ir, undefined), []);
  });

  await it('正则规则按 target 匹配，问题定位到具体节点', () => {
    const problems = applyLint(ir, [
      { id: 'object.pascal', target: 'object', field: 'id', pattern: '^[A-Z]', message: '对象 id 必须大写开头' },
    ]);
    assert.deepEqual(problems, [], '随包资产的对象 id 都是 PascalCase');

    const lower = JSON.parse(JSON.stringify(ir));
    lower.objects[0].id = 'store';
    const hit = applyLint(lower, [
      { id: 'object.pascal', target: 'object', field: 'id', pattern: '^[A-Z]', message: '对象 id 必须大写开头' },
    ]);
    assert.equal(hit.length, 1);
    assert.equal(hit[0].code, 'lint:object.pascal');
    assert.ok(hit[0].path.includes('store'));
  });

  await it('equals 规则可以约束枚举字段', () => {
    const problems = applyLint(ir, [
      { id: 'agent.published', target: 'agent', field: 'status', equals: 'published', message: '上线 Agent 必须 published' },
    ]);
    assert.equal(problems.length, 1, 'store-inspector 是 gray');
    assert.ok(problems[0].message.includes('published'));
  });

  await it('属性与动作也能被约束', () => {
    const properties = applyLint(ir, [
      { id: 'property.label', target: 'property', field: 'label', pattern: '.+', message: '属性必须有中文名' },
    ]);
    // 随包资产的属性都写了 label，应该全过
    assert.deepEqual(properties, []);

    const actions = applyLint(ir, [
      { id: 'action.approval', target: 'action', field: 'approvalRequired', equals: true, message: '写操作一律需要审批' },
    ]);
    assert.ok(actions.some((p) => p.code === 'lint:action.approval'));
  });

  await it('规则本身写错时报出来而不是静默跳过', () => {
    const bad = applyLint(ir, [
      { target: 'object', pattern: '^a' },
      { id: 'bad-target', target: 'nope', pattern: '^a' },
      { id: 'bad-regex', target: 'object', pattern: '[' },
    ]);
    const codes = bad.map((p) => p.code);
    assert.ok(codes.includes('lint-rule-invalid'));
    assert.equal(bad.filter((p) => p.code === 'lint-rule-invalid').length, 3);
  });

  console.log('\n工具集成');

  await it('lint 只报建议，不影响 ok', async () => {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ontology-lint-'));
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
      },
      {
        assetsDir: dir,
        trace: false,
        lintRules: [
          { id: 'agent.published', target: 'agent', field: 'status', equals: 'published', message: '上线 Agent 必须 published' },
        ],
      }
    );
    const tool = registered.find((d) => d.name === 'ontology_validate');
    const value = await tool.execute({}, {});
    assert.equal(value.ok, true, '约定建议不应让校验失败');
    assert.equal(value.lint.length, 1);
    const rendered = tool.output.render({}, value)[0].text;
    assert.ok(rendered.includes('团队约定建议'));
    assert.ok(rendered.includes('不阻断写入'));
  });

  const total = pass + failures.length;
  console.log(`\n${pass}/${total} passed`);
  if (failures.length) {
    for (const f of failures) console.error('\n' + f.name + '\n', f.error);
    process.exit(1);
  }
})();
