/**
 * Asset registry tests: catalog, dependency-ordered install, guarded uninstall.
 * Run `node test/registry.test.cjs`.
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

function tempAssets(withBase = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontology-reg-'));
  if (withBase) fs.copyFileSync(ASSET, path.join(dir, 'store-inventory.ir.json'));
  return dir;
}

async function loadTools(dir) {
  const mod = await import('../index.js');
  const registered = [];
  const ctx = {
    tools: { register: (d) => { registered.push(d); return () => {}; } },
    effect: (run) => run(),
    inject: () => () => {},
    get: () => undefined,
  };
  mod.apply(ctx, { assetsDir: dir, approval: 'never', trace: false, catalogDir: path.join(ROOT, 'catalog') });
  return Object.fromEntries(registered.map((d) => [d.name, d]));
}

(async () => {
  const { catalogState, installAsset, uninstallAsset } = await import('../lib/registry.mjs');
  const { validateIr } = await import('../lib/ir.mjs');
  const catalogDir = path.join(ROOT, 'catalog');

  console.log('\n随包资产');

  await it('会员权益包通过校验，并声明了对门店库存包的依赖', () => {
    const ir = JSON.parse(fs.readFileSync(path.join(catalogDir, 'member-loyalty.ir.json'), 'utf8'));
    const result = validateIr(ir);
    assert.deepEqual(result.problems, [], JSON.stringify(result.problems, null, 2));
    assert.deepEqual(ir.dependsOn, ['retail.store-inventory']);
  });

  await it('依赖自身的包被拦下', () => {
    const ir = JSON.parse(fs.readFileSync(path.join(catalogDir, 'member-loyalty.ir.json'), 'utf8'));
    ir.dependsOn = [ir.id];
    assert.ok(validateIr(ir).problems.some((p) => p.code === 'self-dependency'));
  });

  console.log('\n目录状态');

  await it('列出可安装与已安装，并标注已装状态', async () => {
    const state = await catalogState({ catalogDir, assetsDir: tempAssets() });
    assert.equal(state.available.length, 2, '市场里有会员包和库存包的 1.1.0');
    const member = state.available.find((e) => e.ir.id === 'retail.member-loyalty');
    assert.equal(member.installed, false);
    const upgrade = state.available.find((e) => e.ir.id === 'retail.store-inventory');
    assert.equal(upgrade.upgradable, true, '同 id 不同版本应标为可升级');
    assert.equal(upgrade.installedVersion, '1.0.0');
    assert.equal(upgrade.ir.version, '1.1.0');
    assert.equal(state.installed.length, 1);
    assert.equal(state.installed[0].ir.id, 'retail.store-inventory');
  });

  await it('缺依赖时报告 missingDeps', async () => {
    const state = await catalogState({ catalogDir, assetsDir: tempAssets(false) });
    assert.deepEqual(state.missingDeps, []);

    // 绕过安装检查直接把包放进目录，模拟「依赖被外部删掉」的坏状态
    const dir = tempAssets(false);
    fs.copyFileSync(path.join(catalogDir, 'member-loyalty.ir.json'), path.join(dir, 'member-loyalty.ir.json'));
    const broken = await catalogState({ catalogDir, assetsDir: dir });
    assert.deepEqual(broken.missingDeps, [{ package: 'retail.member-loyalty', missing: 'retail.store-inventory' }]);
  });

  console.log('\n安装');

  await it('依赖满足时安装成功，文件真的落盘', async () => {
    const dir = tempAssets();
    const result = await installAsset({ catalogDir, assetsDir: dir }, 'retail.member-loyalty');
    assert.equal(result.ok, true, result.message);
    assert.equal(result.packageId, 'retail.member-loyalty');
    assert.ok(fs.existsSync(path.join(dir, 'member-loyalty.ir.json')));
  });

  await it('依赖缺失时拒绝安装，且不写文件', async () => {
    const dir = tempAssets(false);
    const result = await installAsset({ catalogDir, assetsDir: dir }, 'retail.member-loyalty');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'missing-dependency');
    assert.deepEqual(result.missing, ['retail.store-inventory']);
    assert.deepEqual(fs.readdirSync(dir), [], '不得留下任何文件');
  });

  await it('重复安装被拒绝', async () => {
    const dir = tempAssets();
    await installAsset({ catalogDir, assetsDir: dir }, 'retail.member-loyalty');
    const again = await installAsset({ catalogDir, assetsDir: dir }, 'retail.member-loyalty');
    assert.equal(again.ok, false);
    assert.equal(again.code, 'already-installed');
  });

  await it('市场里没有的包给出可用清单', async () => {
    const result = await installAsset({ catalogDir, assetsDir: tempAssets() }, 'nope');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'not-in-catalog');
    assert.ok(result.available.includes('retail.member-loyalty'));
    assert.ok(result.available.includes('retail.store-inventory'));
  });

  console.log('\n卸载');

  await it('被依赖时拒绝卸载', async () => {
    const dir = tempAssets();
    await installAsset({ catalogDir, assetsDir: dir }, 'retail.member-loyalty');
    const result = await uninstallAsset({ catalogDir, assetsDir: dir }, 'retail.store-inventory');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'required-by');
    assert.deepEqual(result.requiredBy, ['retail.member-loyalty']);
    assert.ok(fs.existsSync(path.join(dir, 'store-inventory.ir.json')), '文件必须还在');
  });

  await it('先卸依赖方再卸被依赖方即可成功', async () => {
    const dir = tempAssets();
    await installAsset({ catalogDir, assetsDir: dir }, 'retail.member-loyalty');
    assert.equal((await uninstallAsset({ catalogDir, assetsDir: dir }, 'retail.member-loyalty')).ok, true);
    assert.equal((await uninstallAsset({ catalogDir, assetsDir: dir }, 'retail.store-inventory')).ok, true);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  await it('未安装的包报 not-installed 并给出已装清单', async () => {
    const result = await uninstallAsset({ catalogDir, assetsDir: tempAssets() }, 'retail.member-loyalty');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'not-installed');
    assert.deepEqual(result.installed, ['retail.store-inventory']);
  });

  console.log('\n工具层');

  await it('三个工具注册，安装/卸载走同一套逻辑', async () => {
    const dir = tempAssets();
    const tools = await loadTools(dir);
    for (const name of ['ontology_asset_catalog', 'ontology_install_asset', 'ontology_uninstall_asset']) {
      assert.ok(tools[name], '缺少工具 ' + name);
    }
    const cat = await tools.ontology_asset_catalog.execute({}, {});
    assert.equal(cat.ok, true);
    assert.equal(cat.available.length, 2);
    assert.ok(cat.available.every((a) => a.installed === false || a.upgradable === true));

    const install = await tools.ontology_install_asset.execute({ packageId: 'retail.member-loyalty' }, {});
    assert.equal(install.ok, true, install.message);

    const after = await tools.ontology_asset_catalog.execute({}, {});
    assert.equal(after.available[0].installed, true);
    assert.equal(after.installed.length, 2);

    const blocked = await tools.ontology_uninstall_asset.execute({ packageId: 'retail.store-inventory' }, {});
    assert.equal(blocked.ok, false);
    assert.ok(blocked.message.includes('依赖'));
  });

  const total = pass + failures.length;
  console.log(`\n${pass}/${total} passed`);
  if (failures.length) {
    for (const f of failures) console.error('\n' + f.name + '\n', f.error);
    process.exit(1);
  }
})();
