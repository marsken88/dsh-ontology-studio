/**
 * 数据源接入：CSV → 对象草稿 → 资产包 IR。
 *
 * 这两步都是纯函数/纯读取，不写盘、不过审批——落盘那一侧才需要闸门。
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
const SUITE = path.join(ROOT, 'lib', 'datasource.mjs');
const IR = path.join(ROOT, 'lib', 'ir.mjs');

function it(name, fn) {
  return (async () => {
    await fn();
    console.log('  \u2713 ' + name);
  })();
}

(async () => {
  const ds = await import('file://' + SUITE);
  const { validateIr } = await import('file://' + IR);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-'));
  const file = path.join(dir, 'inventory_snapshot.csv');
  fs.writeFileSync(
    file,
    'store_id,sku,on_hand,price,updated_at,note\n' +
      'S-0213,SKU-1001,80,12.5,2026-11-16 09:00,"含,逗号"\n' +
      'S-0188,SKU-1001,95,12.5,2026-11-16 09:30,\n'
  );

  let passed = 0;
  const check = async (name, fn) => {
    await it(name, fn);
    passed += 1;
  };

  await check('parseCsv 处理引号内的逗号', () => {
    const { header, rows } = ds.parseCsv('a,b\n1,"x,y"\n');
    assert.deepEqual(header, ['a', 'b']);
    assert.equal(rows[0][1], 'x,y');
  });

  await check('inferType 按值判断类型，空值不参与', () => {
    assert.equal(ds.inferType(['1', '2']), 'integer');
    assert.equal(ds.inferType(['1.5', '2']), 'number');
    assert.equal(ds.inferType(['true', 'false']), 'boolean');
    assert.equal(ds.inferType(['2026-11-16']), 'date');
    assert.equal(ds.inferType(['2026-11-16 09:00']), 'datetime');
    assert.equal(ds.inferType(['1', '']), 'integer');
    assert.equal(ds.inferType(['', '']), 'string');
  });

  let draft = null;
  await check('draftFromCsvFile 列名归一 + 推断类型 + 填充率', async () => {
    draft = await ds.draftFromCsvFile({ path: file, name: '库存快照' });
    assert.equal(draft.ok, true);
    assert.equal(draft.rowCount, 2);
    assert.deepEqual(
      draft.columns.map((c) => c.property),
      ['storeId', 'sku', 'onHand', 'price', 'updatedAt', 'note']
    );
    assert.equal(draft.columns.find((c) => c.property === 'onHand').type, 'integer');
    assert.equal(draft.columns.find((c) => c.property === 'updatedAt').type, 'datetime');
    const note = draft.columns.find((c) => c.property === 'note');
    assert.ok(note.fillRate < 100, 'note 列有空值，填充率应低于 100%');
  });

  await check('packageFromDraft 生成可校验的资产包', () => {
    const pkg = ds.packageFromDraft(draft, { packageId: 'demo.inventory-snapshot', domain: 'supply-chain' });
    assert.equal(pkg.ok, true);
    assert.equal(pkg.ir.id, 'demo.inventory-snapshot');
    assert.equal(pkg.ir.objects.length, 1);
    assert.deepEqual(pkg.ir.links, []);
    const v = validateIr(pkg.ir);
    assert.ok(v.ok, '生成的包应通过校验：' + JSON.stringify(v.problems));
  });

  await check('草稿无效时 packageFromDraft 不抛错', () => {
    const r = ds.packageFromDraft({ ok: false, problem: '没有表头' });
    assert.equal(r.ok, false);
    assert.equal(r.problem, '没有表头');
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(passed + '/' + passed + ' passed');
})().catch((err) => {
  console.error('FAIL', err && err.message);
  process.exit(1);
});
