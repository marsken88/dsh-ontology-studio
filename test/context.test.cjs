/**
 * Context Engine tests: the ontology brief injected into the model prompt.
 * Run `node test/context.test.cjs`.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const IR = path.join(ROOT, 'assets', 'store-inventory.ir.json');

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
  const { buildBrief } = await import('../lib/context.mjs');
  const ir = JSON.parse(fs.readFileSync(IR, 'utf8'));

  console.log('\nbuildBrief');

  await it('空输入返回空串', () => {
    assert.equal(buildBrief(null), '');
    assert.equal(buildBrief({}), '');
  });

  await it('包含资产包身份信息', () => {
    const brief = buildBrief(ir);
    assert.ok(brief.includes(ir.id));
    assert.ok(brief.includes('v' + ir.version));
    assert.ok(brief.includes(ir.name));
  });

  await it('列出全部对象与主键', () => {
    const brief = buildBrief(ir);
    for (const obj of ir.objects) {
      assert.ok(brief.includes(obj.id), obj.id + ' 未出现在简报里');
    }
    assert.ok(brief.includes('storeId+skuId'), 'Inventory 的复合主键应显示');
  });

  await it('brief 级别下不出属性明细，full 级别才有', () => {
    const brief = buildBrief(ir, { level: 'brief' });
    const full = buildBrief(ir, { level: 'full' });
    assert.ok(!brief.includes('storeName'), 'brief 不应列出全部属性名');
    assert.ok(full.includes('storeName'), 'full 应列出属性名');
    assert.ok(full.length > brief.length);
  });

  await it('区分可执行与不可执行的动作', () => {
    const brief = buildBrief(ir);
    const runnableBlock = brief.split('### 可执行动作')[1] || '';
    assert.ok(runnableBlock.includes('adjustInventory'));
    assert.ok(brief.includes('### 暂不可执行的动作'));
    assert.ok(brief.includes('createTransfer'));
  });

  await it('规则带严重级别与停用标记', () => {
    const brief = buildBrief(ir);
    assert.ok(brief.includes('inventory.lowStockWarning [warn]'));
    assert.ok(brief.includes('inventory.stockoutAlert [error]'));
    assert.ok(brief.includes('已停用'), '停用的规则应标出来');
  });

  await it('同样的本体产出逐字相同的文本（不破坏 prompt 缓存）', () => {
    assert.equal(buildBrief(ir), buildBrief(ir));
    assert.equal(buildBrief(ir, { level: 'full' }), buildBrief(ir, { level: 'full' }));
  });

  await it('超长时先降级细节，再截断并说明', () => {
    const tiny = buildBrief(ir, { maxChars: 500, level: 'full' });
    assert.ok(tiny.includes('已截断'), '应当有截断标记');
    assert.ok(tiny.length <= 500 + 120, '截断后不应远超上限');
    assert.ok(tiny.startsWith('## 本体上下文'), '截断应保留开头');
  });

  await it('maxChars 有下限保护，不会被设成 0 后吐空串', () => {
    const brief = buildBrief(ir, { maxChars: 0 });
    assert.ok(brief.length > 400);
  });

  await it('没有动作或规则时不崩，且如实写「无」', () => {
    const sparse = { id: 'x.y', name: '空包', version: '0.0.1', objects: [{ id: 'A', name: 'A', properties: [{ name: 'a', type: 'string' }] }], links: [] };
    const brief = buildBrief(sparse);
    assert.ok(brief.includes('规则（0 条）'));
    assert.ok(brief.includes('- 无'));
    assert.ok(brief.includes('无（动作都缺 inputSchema 或 effect）'));
  });

  const total = pass + failures.length;
  console.log(`\n${pass}/${total} passed`);
  if (failures.length) {
    for (const f of failures) console.error('\n' + f.name + '\n', f.error);
    process.exit(1);
  }
})();
