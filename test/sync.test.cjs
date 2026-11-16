/**
 * 同步状态：什么时候读的、多少行、和上次比变了什么。
 *
 * 全是纯函数，不需要文件系统——落盘那一侧在 tools 里，由审批闸门守着。
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
const SYNC = path.join(ROOT, 'lib', 'sync.mjs');
const DATASOURCE = path.join(ROOT, 'lib', 'datasource.mjs');

function it(name, fn) {
  return (async () => {
    await fn();
    console.log('  \u2713 ' + name);
  })();
}

(async () => {
  const sync = await import('file://' + SYNC);
  const ds = await import('file://' + DATASOURCE);

  let passed = 0;
  const check = async (name, fn) => {
    await it(name, fn);
    passed += 1;
  };

  await check('fingerprintOf 相同内容同指纹，内容变了指纹就变', () => {
    const a = sync.fingerprintOf(['s', 'q'], [['S-1', '80']]);
    const b = sync.fingerprintOf(['s', 'q'], [['S-1', '80']]);
    const c = sync.fingerprintOf(['s', 'q'], [['S-1', '81']]);
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.ok(a.startsWith('sha256-'), '指纹形状应与 store.etagOf 一致');
  });

  await check('fingerprintOf 不吃单元格拼接的亏', () => {
    // 不定长度前缀的话，["ab","c"] 和 ["a","bc"] 会撞成同一串
    const a = sync.fingerprintOf(['x', 'y'], [['ab', 'c']]);
    const b = sync.fingerprintOf(['x', 'y'], [['a', 'bc']]);
    assert.notEqual(a, b);
  });

  await check('diffColumns 认出新增列、消失列、类型变化', () => {
    const d = sync.diffColumns(
      [
        { name: 'store_id', type: 'string' },
        { name: 'qty', type: 'integer' },
        { name: 'gone', type: 'string' },
      ],
      [
        { name: 'store_id', type: 'string' },
        { name: 'qty', type: 'number' },
        { name: 'fresh', type: 'date' },
      ]
    );
    assert.deepEqual(d.added, ['fresh']);
    assert.deepEqual(d.removed, ['gone']);
    assert.deepEqual(d.typeChanged, [{ name: 'qty', from: 'integer', to: 'number' }]);
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-'));
  const file = path.join(dir, 'stock.csv');
  fs.writeFileSync(file, 'store_id,qty\nS-0213,80\nS-0188,95\n');

  let first = null;
  await check('首次接入：changes.first 为真，runs 从 1 开始', async () => {
    const draft = await ds.draftFromCsvFile({ path: file });
    assert.ok(draft.hash, '草稿应带上内容指纹');
    const r = sync.nextSyncState({ packageId: 'demo.stock', draft, now: '2026-11-16T09:00:00.000Z' });
    assert.equal(r.ok, true);
    first = r.state;
    assert.equal(first.changes.first, true);
    assert.equal(first.changes.dataChanged, true);
    assert.equal(first.rowCount, 2);
    assert.equal(first.columnCount, 2);
    assert.equal(first.runs, 1);
    assert.equal(first.previous, null);
    assert.equal(first.hash, draft.hash);
    assert.equal(first.at, '2026-11-16T09:00:00.000Z');
  });

  await check('文件没变：dataChanged 为假，行数增量 0', async () => {
    const draft = await ds.draftFromCsvFile({ path: file });
    const r = sync.nextSyncState({ packageId: 'demo.stock', draft, previous: first, now: '2026-11-17T09:00:00.000Z' });
    assert.equal(r.state.changes.dataChanged, false);
    assert.equal(r.state.changes.rowDelta, 0);
    assert.equal(r.state.changes.first, false);
    assert.equal(r.state.runs, 2);
    assert.deepEqual(r.state.previous, { at: first.at, hash: first.hash, rowCount: 2 });
  });

  await check('加了行：rowDelta 为正，指纹变化', async () => {
    fs.writeFileSync(file, 'store_id,qty\nS-0213,80\nS-0188,95\nS-0300,12\n');
    const draft = await ds.draftFromCsvFile({ path: file });
    const r = sync.nextSyncState({ packageId: 'demo.stock', draft, previous: first });
    assert.equal(r.state.rowCount, 3);
    assert.equal(r.state.changes.rowDelta, 1);
    assert.equal(r.state.changes.dataChanged, true);
    assert.equal(r.state.changes.schemaChanged, false);
  });

  await check('加了列：added + schemaChanged，类型变化也认', async () => {
    fs.writeFileSync(file, 'store_id,qty,lead_time\nS-0213,80,2\nS-0188,95,3\n');
    const draft = await ds.draftFromCsvFile({ path: file });
    const r = sync.nextSyncState({ packageId: 'demo.stock', draft, previous: first });
    assert.deepEqual(r.state.changes.added, ['lead_time']);
    assert.deepEqual(r.state.changes.removed, []);
    assert.equal(r.state.changes.schemaChanged, true);
  });

  await check('草稿无效时不抛错，返回 problem', () => {
    const r = sync.nextSyncState({ packageId: 'demo.stock', draft: { ok: false, problem: '没有表头' } });
    assert.equal(r.ok, false);
    assert.equal(r.problem, '没有表头');
  });

  await check('syncFileName 把 .ir.json 换成 .sync.json', () => {
    assert.equal(sync.syncFileName('demo.stock.ir.json'), 'demo.stock.sync.json');
    assert.equal(sync.syncFileName('demo.stock.sync.json'), 'demo.stock.sync.json');
  });

  await check('describeSync 说人话：首次 / 变化 / 无变化', () => {
    assert.equal(sync.describeSync(null), '尚未同步');
    assert.match(sync.describeSync(first), /首次接入于 2026-11-16 09:00:00：2 行 × 2 列/);
    const changed = sync.nextSyncState({
      packageId: 'demo.stock',
      draft: {
        ok: true,
        rowCount: 5,
        hash: 'sha256-ffff',
        columns: [
          { name: 'store_id', property: 'storeId', type: 'string' },
          { name: 'a', property: 'a', type: 'string' },
        ],
      },
      previous: first,
    }).state;
    assert.match(sync.describeSync(changed), /行数 \+3/);
    assert.match(sync.describeSync(changed), /新增列 a/);
    assert.match(sync.describeSync(changed), /消失列 qty/);
  });

  await check('describeSync 文件没变时说「无变化」而不是编一个变化', async () => {
    const draft = await ds.draftFromCsvFile({ path: file });
    const a = sync.nextSyncState({ packageId: 'demo.stock', draft }).state;
    const b = sync.nextSyncState({ packageId: 'demo.stock', draft, previous: a }).state;
    assert.match(sync.describeSync(b), /无变化/);
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(passed + '/' + passed + ' passed');
})().catch((err) => {
  console.error('FAIL', err && err.message);
  process.exit(1);
});
