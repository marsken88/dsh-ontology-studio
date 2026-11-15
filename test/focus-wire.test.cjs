/**
 * Task-layer context, end to end: a pre-step observation must change the
 * system-prompt section text on the very next read.
 * Run `node test/focus-wire.test.cjs`.
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

async function boot(config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontology-wire-'));
  fs.copyFileSync(ASSET, path.join(dir, 'store-inventory.ir.json'));
  fs.copyFileSync(path.join(ROOT, 'assets', 'store-inventory.records.json'), path.join(dir, 'store-inventory.records.json'));

  const mod = await import('../index.js');
  const captured = { sections: [], listeners: [] };
  const ctx = {
    tools: { register: () => () => {} },
    effect: (run) => run(),
    inject: (deps, cb) => {
      if (deps.includes('systemPrompt')) {
        cb({
          systemPrompt: {
            section: (spec) => {
              captured.sections.push(spec);
              return () => {};
            },
          },
        });
      }
      return () => {};
    },
    get: () => undefined,
    on: (name, listener) => {
      captured.listeners.push({ name, listener });
    },
    off: () => {},
  };
  mod.apply(ctx, Object.assign({ assetsDir: dir, trace: false, approval: 'never' }, config));
  // The brief is built asynchronously; give it a tick.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return captured;
}

const mention = (text) => [{ role: 'user', content: text }];

(async () => {
  console.log('\n段落与监听');

  await it('注册了段落和 agent/pre-step 监听', async () => {
    const captured = await boot();
    assert.equal(captured.sections.length, 1);
    assert.equal(captured.listeners.filter((l) => l.name === 'agent/pre-step').length, 1);
  });

  await it('没有观察时，段落就是纯简报', async () => {
    const captured = await boot();
    const text = captured.sections[0].text();
    assert.ok(text.length > 200, '应当有本体简报');
    assert.ok(!text.includes('本轮可能相关'), '未观察时不应有聚焦提示');
  });

  console.log('\n观察驱动');

  await it('提到对象后，下一次读段落会多一行聚焦提示', async () => {
    const captured = await boot();
    const [{ listener }] = captured.listeners.filter((l) => l.name === 'agent/pre-step');
    await listener({ messages: mention('Inventory 的可用库存是不是不够了？'), agent: { id: 'session-1' } }, async () => ({ kind: 'enter', messages: [] }));

    const text = captured.sections[0].text();
    assert.ok(text.includes('本轮可能相关'), '应当追加聚焦提示');
    assert.ok(text.includes('Inventory'), '应当点名 Inventory');
  });

  await it('换一句话就换成新的聚焦', async () => {
    const captured = await boot();
    const [{ listener }] = captured.listeners.filter((l) => l.name === 'agent/pre-step');
    await listener({ messages: mention('Inventory 够吗'), agent: { id: 's' } }, async () => ({ kind: 'enter', messages: [] }));
    assert.ok(captured.sections[0].text().includes('Inventory'));

    await listener({ messages: mention('Supplier 的交付周期怎么样'), agent: { id: 's' } }, async () => ({ kind: 'enter', messages: [] }));
    const text = captured.sections[0].text();
    assert.ok(text.includes('Supplier'));
    assert.ok(!text.includes('Inventory（'), '旧聚焦应被替换');
  });

  await it('没提到任何对象时不再显示聚焦', async () => {
    const captured = await boot();
    const [{ listener }] = captured.listeners.filter((l) => l.name === 'agent/pre-step');
    await listener({ messages: mention('Supplier 怎么样'), agent: { id: 's' } }, async () => ({ kind: 'enter', messages: [] }));
    assert.ok(captured.sections[0].text().includes('Supplier'));

    await listener({ messages: mention('继续'), agent: { id: 's' } }, async () => ({ kind: 'enter', messages: [] }));
    assert.ok(!captured.sections[0].text().includes('本轮可能相关'));
  });

  await it('监听器总是放行，绝不拦截这一步', async () => {
    const captured = await boot();
    const [{ listener }] = captured.listeners.filter((l) => l.name === 'agent/pre-step');
    let called = false;
    const decision = await listener({ messages: mention('Inventory'), agent: { id: 's' } }, async () => {
      called = true;
      return { kind: 'enter', messages: [] };
    });
    assert.equal(called, true, '必须调用 next()');
    assert.equal(decision.kind, 'enter');
  });

  await it('payload 缺字段也不会抛错', async () => {
    const captured = await boot();
    const [{ listener }] = captured.listeners.filter((l) => l.name === 'agent/pre-step');
    for (const payload of [undefined, {}, { messages: [] }, { messages: [{ role: 'user' }] }]) {
      await listener(payload, async () => ({ kind: 'enter', messages: [] }));
    }
    assert.ok(true, '不应抛错');
  });

  await it("context: 'off' 时不注册任何东西", async () => {
    const captured = await boot({ context: 'off' });
    assert.equal(captured.sections.length, 0);
    assert.equal(captured.listeners.filter((l) => l.name === 'agent/pre-step').length, 0);
  });

  const total = pass + failures.length;
  console.log(`\n${pass}/${total} passed`);
  if (failures.length) {
    for (const f of failures) console.error('\n' + f.name + '\n', f.error);
    process.exit(1);
  }
})();
