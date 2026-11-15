/**
 * Task-layer focus tests.
 * Run `node test/focus.test.cjs`.
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
  const { focusOf, messageText } = await import('../lib/focus.mjs');
  const ir = JSON.parse(fs.readFileSync(ASSET, 'utf8'));

  console.log('\nmessageText');

  await it('拼接字符串内容与文本块，忽略其他块', () => {
    const text = messageText([
      { role: 'user', content: '帮我看库存' },
      { role: 'user', content: [{ type: 'text', text: '再看看门店' }, { type: 'image', source: {} }] },
    ]);
    assert.equal(text, '帮我看库存\n再看看门店');
  });

  await it('空输入返回空串', () => {
    assert.equal(messageText([]), '');
    assert.equal(messageText(undefined), '');
  });

  console.log('\nfocusOf');

  await it('提到对象 id 时命中，权重最高', () => {
    const focused = focusOf(ir, 'Inventory 这家店还够卖吗');
    assert.equal(focused[0].id, 'Inventory');
    assert.ok(focused[0].score >= 3);
  });

  await it('提到中文名也能命中', () => {
    const focused = focusOf(ir, '帮我看一下库存和供应商');
    const ids = focused.map((o) => o.id);
    assert.ok(ids.includes('Inventory'));
    assert.ok(ids.includes('Supplier'));
  });

  await it('只提到属性名也能定位到所属对象', () => {
    const focused = focusOf(ir, 'safetyStock 设得太高了吧');
    assert.equal(focused[0].id, 'Inventory');
  });

  await it('没有提到任何对象时返回空数组', () => {
    assert.deepEqual(focusOf(ir, '还有哪些功能没有完成'), []);
    assert.deepEqual(focusOf(ir, ''), []);
  });

  await it('默认只给前三个，按分数排序', () => {
    const focused = focusOf(ir, '库存 门店 商品 订单 会员');
    assert.equal(focused.length, 3);
    const scores = focused.map((o) => o.score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  });

  await it('limit 可调', () => {
    assert.equal(focusOf(ir, '库存 门店 商品 订单 会员', { limit: 5 }).length, 5);
  });

  await it('同一句话两次打分完全一致', () => {
    const a = JSON.stringify(focusOf(ir, 'SKU-1001 卖不动了'));
    const b = JSON.stringify(focusOf(ir, 'SKU-1001 卖不动了'));
    assert.equal(a, b);
  });

  const total = pass + failures.length;
  console.log(`\n${pass}/${total} passed`);
  if (failures.length) {
    for (const f of failures) console.error('\n' + f.name + '\n', f.error);
    process.exit(1);
  }
})();
