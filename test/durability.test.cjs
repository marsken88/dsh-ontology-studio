/**
 * Write-path attacks: concurrency, compare-and-swap, and failure.
 * These probe promises the README makes, not happy-path behaviour.
 * Run `node test/durability.test.cjs`.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
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

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontology-dur-'));
  fs.copyFileSync(ASSET, path.join(dir, 'store-inventory.ir.json'));
  fs.copyFileSync(RECORDS, path.join(dir, 'store-inventory.records.json'));
  return dir;
}

(async () => {
  const { createStore, etagOf, bumpVersion } = await import('../lib/store.mjs');

  console.log('\ncompare-and-swap');

  await it('拿旧 etag 写入被拒绝，磁盘保持外部修改后的内容', async () => {
    const dir = tempDir();
    const store = createStore({ dir });
    const { entry } = await store.get('retail.store-inventory');
    const staleEtag = entry.etag;

    // Someone edits the file on disk (that is the whole "deploy" step).
    const changed = JSON.parse(fs.readFileSync(entry.path, 'utf8'));
    changed.description = '被别人改过';
    fs.writeFileSync(entry.path, JSON.stringify(changed, null, 2) + '\n');
    const afterExternal = fs.readFileSync(entry.path, 'utf8');

    const result = await store.save(entry.file, entry.ir, { ifEtag: staleEtag });
    assert.equal(result.ok, false);
    assert.equal(result.conflict, true, '应当报冲突而不是静默覆盖');
    assert.notEqual(result.etag, staleEtag, '应当返回当前 etag 供重试');
    assert.equal(fs.readFileSync(entry.path, 'utf8'), afterExternal, '磁盘内容不得被覆盖');
  });

  await it('etag 正确时写入成功，且 etag 随之改变', async () => {
    const dir = tempDir();
    const store = createStore({ dir });
    const { entry } = await store.get('retail.store-inventory');
    const next = JSON.parse(JSON.stringify(entry.ir));
    next.description = '正常写入';
    const result = await store.save(entry.file, next, { ifEtag: entry.etag });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.notEqual(result.etag, entry.etag);
    assert.equal(result.etag, etagOf(fs.readFileSync(entry.path, 'utf8')));
  });

  console.log('\n并发');

  await it('同一 etag 并发两次：只有一个成功，另一个冲突', async () => {
    const dir = tempDir();
    const store = createStore({ dir });
    const { entry } = await store.get('retail.store-inventory');

    const write = (tag) => {
      const next = JSON.parse(JSON.stringify(entry.ir));
      next.description = tag;
      return store.save(entry.file, next, { ifEtag: entry.etag });
    };
    const [a, b] = await Promise.all([write('A'), write('B')]);
    const wins = [a, b].filter((r) => r.ok).length;
    const conflicts = [a, b].filter((r) => r.conflict).length;
    assert.equal(wins, 1, '必须恰好一个成功');
    assert.equal(conflicts, 1, '另一个必须是冲突');
    const final = JSON.parse(fs.readFileSync(entry.path, 'utf8')).description;
    assert.ok(final === 'A' || final === 'B');
  });

  await it('不带 etag 的十次并发写不会交错出坏文件', async () => {
    const dir = tempDir();
    const store = createStore({ dir });
    const { entry } = await store.get('retail.store-inventory');

    await Promise.all(
      Array.from({ length: 10 }, (_, i) => {
        const next = JSON.parse(JSON.stringify(entry.ir));
        next.description = '并发 ' + i;
        return store.save(entry.file, next);
      })
    );
    const text = fs.readFileSync(entry.path, 'utf8');
    const parsed = JSON.parse(text); // 解析不了就说明写坏了
    assert.ok(parsed.description.startsWith('并发 '));
    assert.equal(text.endsWith('\n'), true);
  });

  await it('工具层十个并发 upsert 一个都不丢', async () => {
    const dir = tempDir();
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
      { assetsDir: dir, trace: false, approval: 'never' }
    );
    const upsert = registered.find((d) => d.name === 'ontology_upsert_object');

    const calls = Array.from({ length: 10 }, (_, i) =>
      upsert.execute(
        {
          packageId: 'retail.store-inventory',
          object: {
            id: 'Bulk' + i,
            name: '并发对象' + i,
            keys: ['id'],
            properties: [{ name: 'id', type: 'string', required: true }],
          },
        },
        {}
      )
    );
    const results = await Promise.all(calls);
    const okCount = results.filter((r) => r.ok).length;
    assert.equal(okCount, 10, '十次都该成功：' + JSON.stringify(results.filter((r) => !r.ok).map((r) => r.message)));

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'store-inventory.ir.json'), 'utf8'));
    const added = onDisk.objects.filter((o) => String(o.id).startsWith('Bulk'));
    assert.equal(added.length, 10, '磁盘上必须十个都在，丢了就是 lost update');
  });

  console.log('\n原子性与失败');

  await it('写入过程不留临时文件', async () => {
    const dir = tempDir();
    const store = createStore({ dir });
    const { entry } = await store.get('retail.store-inventory');
    const next = JSON.parse(JSON.stringify(entry.ir));
    next.description = '清理检查';
    await store.save(entry.file, next);
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, [], '不应残留 ' + JSON.stringify(leftovers));
  });

  await it('目标文件被占用导致改名失败时，原文件仍是完整的旧内容', async () => {
    if (process.platform !== 'win32') {
      // 只读文件在 POSIX 上仍可被 rename 覆盖，这个用例只在 Windows 有意义
      return;
    }
    const dir = tempDir();
    const store = createStore({ dir });
    const { entry } = await store.get('retail.store-inventory');
    const original = fs.readFileSync(entry.path, 'utf8');

    // 让目标文件只读，rename 会失败
    fs.chmodSync(entry.path, 0o444);
    const next = JSON.parse(JSON.stringify(entry.ir));
    next.description = '应该写不进去';
    let threw = false;
    try {
      await store.save(entry.file, next);
    } catch {
      threw = true;
    }
    fs.chmodSync(entry.path, 0o666);

    assert.equal(threw, true, '应当抛错而不是假装成功');
    assert.equal(fs.readFileSync(entry.path, 'utf8'), original, '原文件必须完好');
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, [], '失败也应清理临时文件');
  });

  await it('非法包被拒绝时磁盘不变', async () => {
    const dir = tempDir();
    const store = createStore({ dir });
    const { entry } = await store.get('retail.store-inventory');
    const original = fs.readFileSync(entry.path, 'utf8');
    const broken = JSON.parse(JSON.stringify(entry.ir));
    broken.objects[0].properties = [];
    const result = await store.save(entry.file, broken);
    assert.equal(result.ok, false);
    assert.ok(result.problems.length > 0);
    assert.equal(fs.readFileSync(entry.path, 'utf8'), original);
  });

  console.log('\n版本号');

  await it('bumpVersion 常见与异常输入', () => {
    assert.equal(bumpVersion('1.2.3'), '1.2.4');
    assert.equal(bumpVersion('1.2.3', 'minor'), '1.3.0');
    assert.equal(bumpVersion('1.2.3', 'major'), '2.0.0');
    assert.equal(bumpVersion('1.2', 'patch'), '1.2.1');
    assert.equal(bumpVersion('1', 'minor'), '1.1.0');
    assert.equal(bumpVersion('1.2.3', 'nonsense'), '1.2.4', '未知 bump 回落到 patch');
  });

  const total = pass + failures.length;
  console.log(`\n${pass}/${total} passed`);
  if (failures.length) {
    for (const f of failures) console.error('\n' + f.name + '\n', f.error);
    process.exit(1);
  }
})();
