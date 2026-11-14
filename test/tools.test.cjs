/**
 * Host half tests: activate the plugin against a fake context exactly as the
 * Host would, then exercise every registered tool end to end against the real
 * asset directory. Run `node test/tools.test.cjs`.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
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

function fakeContext(options = {}) {
  const registered = [];
  const effects = [];
  const routes = [];
  const sections = [];
  const webServer = {
    register(route) {
      routes.push(route);
      return () => {};
    },
  };
  const systemPrompt = {
    section(section) {
      sections.push(section);
      return () => {};
    },
  };
  return {
    registered,
    effects,
    routes,
    sections,
    ctx: {
      tools: {
        register(definition) {
          if (registered.some((d) => d.name === definition.name)) {
            throw new Error('duplicate tool registration: ' + definition.name);
          }
          registered.push(definition);
          return () => {};
        },
      },
      effect(run) {
        const disposer = run();
        effects.push(disposer);
        return disposer;
      },
      /** Mirrors Cordis: the callback runs only when every dependency is present. */
      inject(deps, callback) {
        if (deps.includes('webServer') && options.webServer !== false) {
          callback({ webServer });
        }
        if (deps.includes('systemPrompt') && options.systemPrompt !== false) {
          callback({ systemPrompt });
        }
        return () => {};
      },
      /** Optional-service lookup, as Cordis exposes it. */
      get(name) {
        return name === 'approval' ? options.approval : undefined;
      },
    },
  };
}

(async () => {
  const mod = await import('../index.js');

  console.log('\nactivation');

  const { ctx, registered, effects, sections } = fakeContext();
  const config = { assetsDir: path.join(ROOT, 'assets'), trace: false };

  await it('apply 不抛错并注册十四个工具', () => {
    mod.apply(ctx, config);
    assert.deepEqual(registered.map((d) => d.name).sort(), [
      'ontology_delete_link',
      'ontology_delete_object',
      'ontology_diagnostics',
      'ontology_draft_object',
      'ontology_evaluate_rules',
      'ontology_execute_action',
      'ontology_get',
      'ontology_impact',
      'ontology_list',
      'ontology_publish',
      'ontology_records',
      'ontology_upsert_link',
      'ontology_upsert_object',
      'ontology_validate',
    ]);
  });

  await it('每个注册都挂在 ctx.effect 上（可卸载）', () => {
    // 11 个工具 + 1 个上下文段落的释放器
    assert.equal(effects.length, registered.length + 1);
    for (const d of effects) assert.equal(typeof d, 'function');
  });

  await it("writeMode: 'readonly' 时只注册八个读工具", () => {
    const alt = fakeContext();
    mod.apply(alt.ctx, { assetsDir: config.assetsDir, writeMode: 'readonly', trace: false });
    assert.deepEqual(alt.registered.map((d) => d.name).sort(), [
      'ontology_diagnostics',
      'ontology_draft_object',
      'ontology_evaluate_rules',
      'ontology_get',
      'ontology_impact',
      'ontology_list',
      'ontology_records',
      'ontology_validate',
    ]);
  });

  await it('注册本体上下文段落（systemPrompt section）', () => {
    assert.equal(sections.length, 1, '默认应注册一个段落');
    const section = sections[0];
    assert.equal(section.name, 'ontology-studio');
    assert.equal(typeof section.order, 'number');
    assert.equal(typeof section.text, 'function');
    const text = section.text();
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 0, '简报不能为空');
  });

  await it("context: 'off' 时不注册上下文段落", () => {
    const alt = fakeContext();
    mod.apply(alt.ctx, { assetsDir: config.assetsDir, trace: false, context: 'off' });
    assert.equal(alt.sections.length, 0);
    assert.equal(alt.registered.length, 14, '工具仍应全部注册');
  });

  await it('没有 systemPrompt 服务时插件照常工作', () => {
    const alt = fakeContext({ systemPrompt: false });
    mod.apply(alt.ctx, { assetsDir: config.assetsDir, trace: false });
    assert.equal(alt.registered.length, 14);
  });

  await it('ontology_diagnostics 报出版本、配置与检查项', async () => {
    const alt = fakeContext();
    mod.apply(alt.ctx, { assetsDir: path.join(ROOT, 'assets'), trace: false, approval: 'all' });
    const tool = alt.registered.find((d) => d.name === 'ontology_diagnostics');
    assert.ok(tool, '应当注册 ontology_diagnostics');
    const value = await tool.execute({}, {});
    assert.equal(value.ok, true, JSON.stringify(value.checks));
    assert.match(value.version, /^\d+\.\d+\.\d+$/, '版本应当来自 package.json');
    assert.equal(value.config.approval, 'all');
    assert.equal(value.config.writeMode, 'open');
    assert.equal(value.config.context, 'brief');
    const names = value.checks.map((c) => c.name);
    for (const expected of ['资产目录', '资产包', '写入能力', '上下文简报', '工具注册', '执行轨迹']) {
      assert.ok(names.includes(expected), '缺少检查项：' + expected);
    }
    assert.ok(value.checks.every((c) => ['ok', 'warn', 'fail'].includes(c.status)));
  });

  await it('readonly 模式下自检如实报告只读', async () => {
    const alt = fakeContext();
    mod.apply(alt.ctx, { assetsDir: path.join(ROOT, 'assets'), trace: false, writeMode: 'readonly' });
    const tool = alt.registered.find((d) => d.name === 'ontology_diagnostics');
    const value = await tool.execute({}, {});
    const writeCheck = value.checks.find((c) => c.name === '写入能力');
    assert.equal(writeCheck.status, 'warn');
    assert.ok(writeCheck.detail.includes('只读'));
    assert.ok(value.checks.find((c) => c.name === '工具注册').detail.includes('8 个'));
  });

  await it('每个工具都有 parameters 与 output.schema/render', () => {
    for (const def of registered) {
      assert.equal(typeof def.description, 'string');
      assert.ok(def.description.length > 20, def.name + ' 缺少描述');
      assert.equal(def.parameters.type, 'object');
      assert.ok(def.output && def.output.schema, def.name + ' 缺少 output.schema');
      assert.equal(typeof def.output.render, 'function');
      assert.equal(typeof def.execute, 'function');
    }
  });

  await it('inject 声明了 tools 硬依赖', () => {
    assert.deepEqual(mod.inject, ['tools']);
  });

  const byName = Object.fromEntries(registered.map((d) => [d.name, d]));

  console.log('\ntools');

  await it('ontology_list 列出资产包并带统计', async () => {
    const value = await byName.ontology_list.execute({}, {});
    assert.equal(value.packages.length, 1);
    const pkg = value.packages[0];
    assert.equal(pkg.id, 'retail.store-inventory');
    assert.equal(pkg.objects, 6);
    assert.equal(pkg.ok, true);
    const rendered = byName.ontology_list.output.render({}, value);
    assert.equal(rendered[0].type, 'text');
    assert.ok(rendered[0].text.includes('retail.store-inventory'));
  });

  await it('ontology_get 不带 objectId 时返回包摘要', async () => {
    const value = await byName.ontology_get.execute({ packageId: 'retail.store-inventory' }, {});
    assert.equal(value.found, true);
    assert.equal(value.package.version, '1.0.0');
    assert.equal(value.objects.length, 6);
  });

  await it('ontology_get 带 objectId 时返回属性/关系/动作', async () => {
    const value = await byName.ontology_get.execute(
      { packageId: 'retail.store-inventory', objectId: 'Inventory' },
      {}
    );
    assert.equal(value.found, true);
    assert.equal(value.object.id, 'Inventory');
    assert.equal(value.object.properties.length, 7);
    assert.deepEqual(value.links.map((l) => l.target).sort(), ['Product', 'Store']);
    assert.deepEqual(value.actions.map((a) => a.id).sort(), [
      'adjustInventory',
      'createTransfer',
      'startStocktake',
    ]);
    const rendered = byName.ontology_get.output.render({}, value);
    assert.ok(rendered[0].text.includes('可售数量'));
  });

  await it('ontology_get 对不存在的包/对象给出可用清单', async () => {
    const missingPkg = await byName.ontology_get.execute({ packageId: 'nope' }, {});
    assert.equal(missingPkg.found, false);
    assert.deepEqual(missingPkg.available, ['retail.store-inventory']);

    const missingObj = await byName.ontology_get.execute(
      { packageId: 'retail.store-inventory', objectId: 'Ghost' },
      {}
    );
    assert.equal(missingObj.found, false);
    assert.ok(missingObj.objects.length === 6);
  });

  await it('ontology_validate 对随包资产返回 ok', async () => {
    const value = await byName.ontology_validate.execute({}, {});
    assert.deepEqual(value.problems, []);
    assert.equal(value.ok, true);
    assert.deepEqual(value.checked, ['retail.store-inventory']);
  });

  await it('ontology_validate 对不存在的包报告 not-found', async () => {
    const value = await byName.ontology_validate.execute({ packageId: 'nope' }, {});
    assert.equal(value.ok, false);
    assert.equal(value.problems[0].code, 'not-found');
  });

  await it('ontology_impact 返回 Inventory 的下游依赖', async () => {
    const value = await byName.ontology_impact.execute(
      { packageId: 'retail.store-inventory', objectId: 'Inventory' },
      {}
    );
    assert.equal(value.found, true);
    assert.equal(value.dependents, 6);
    assert.equal(value.actions.length, 3);
    assert.equal(value.rules.length, 3);
    const rendered = byName.ontology_impact.output.render({}, value);
    assert.ok(rendered[0].text.includes('6 个直接下游依赖'));
  });

  await it('ontology_impact 对不存在的对象提示可用对象', async () => {
    const value = await byName.ontology_impact.execute(
      { packageId: 'retail.store-inventory', objectId: 'Ghost' },
      {}
    );
    assert.equal(value.found, false);
    assert.ok(value.message.includes('Inventory'));
  });

  await it('资产目录不存在时工具优雅降级', async () => {
    const alt = fakeContext();
    mod.apply(alt.ctx, { assetsDir: path.join(ROOT, 'no-such-dir') });
    const list = Object.fromEntries(alt.registered.map((d) => [d.name, d]));
    const listed = await list.ontology_list.execute({}, {});
    assert.deepEqual(listed.packages, []);
    assert.equal(listed.missingDir, true);
    const validated = await list.ontology_validate.execute({}, {});
    assert.equal(validated.ok, false);
    assert.equal(validated.problems[0].code, 'missing-dir');
  });

  await it('ontology_records 报出行数与样例，能按对象过滤', async () => {
    const all = await byName.ontology_records.execute({ packageId: 'retail.store-inventory' }, {});
    assert.equal(all.ok, true);
    assert.equal(all.totalRows, 11);
    assert.ok(all.objects.length >= 3);
    const rendered = byName.ontology_records.output.render({}, all);
    assert.ok(rendered[0].text.includes('11 行'));

    const one = await byName.ontology_records.execute(
      { packageId: 'retail.store-inventory', objectId: 'Inventory', limit: 2 },
      {}
    );
    assert.equal(one.objects.length, 1);
    assert.equal(one.objects[0].id, 'Inventory');
    assert.equal(one.objects[0].rows, 5);
    assert.equal(one.objects[0].sample.length, 2, 'limit 应生效');
    assert.equal(one.objects[0].sample[0].skuId, 'SKU-1001');
  });

  await it('ontology_records 对未知对象与缺数据文件给出明确错误', async () => {
    const ghost = await byName.ontology_records.execute(
      { packageId: 'retail.store-inventory', objectId: 'Ghost' },
      {}
    );
    assert.equal(ghost.ok, false);
    assert.ok(ghost.message.includes('Inventory'));

    const alt = fakeContext();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontology-norec-'));
    fs.copyFileSync(path.join(ROOT, 'assets', 'store-inventory.ir.json'), path.join(dir, 'store-inventory.ir.json'));
    mod.apply(alt.ctx, { assetsDir: dir, trace: false });
    const tool = alt.registered.find((d) => d.name === 'ontology_records');
    const missing = await tool.execute({ packageId: 'retail.store-inventory' }, {});
    assert.equal(missing.ok, false);
    assert.ok(missing.message.includes('示例数据'));
  });

  const total = pass + failures.length;
  console.log(`\n${pass}/${total} passed`);
  if (failures.length) {
    for (const f of failures) console.error('\n' + f.name + '\n', f.error);
    process.exit(1);
  }
})();
