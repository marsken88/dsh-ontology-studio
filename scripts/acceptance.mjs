#!/usr/bin/env node
/**
 * 部署后验收：对着一个正在跑的实例，把只读接口挨个打一遍，核对关键不变量。
 *
 * 用法：
 *   node scripts/acceptance.mjs --base http://192.168.120.218
 *   node scripts/acceptance.mjs --base http://127.0.0.1:49430 --package retail.store-inventory
 *
 * 为什么单独有这个脚本：改了代码、部署、然后「看起来没问题」是最危险的验收方式。
 * 这份脚本只做只读检查，不改任何数据，可以随时对生产实例跑。
 */
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const base = opt('base', 'http://127.0.0.1:55896').replace(/\/$/, '');
const wanted = opt('package', '');
const PREFIX = '/dsh-ontology-studio';

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });
}

async function get(path) {
  const res = await fetch(base + PREFIX + path, { headers: { accept: 'application/json' } });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body };
}

(async () => {
  console.log(`验收：${base}\n`);

  // 1. 宿主与资产
  const status = await get('/status');
  check('GET /status', status.status === 200 && status.body.ok === true, `HTTP ${status.status}`);
  const value = (status.body && status.body.value) || {};
  check('  · 版本号存在', typeof value.version === 'string' && value.version.length > 0, value.version);
  check('  · 资产目录存在', value.missingDir === false, value.dir);
  const packages = (value.packages || []).filter((p) => p.ok);
  check('  · 至少一个可读资产包', packages.length > 0, `${packages.length} 个`);

  const target = wanted || (packages[0] && packages[0].id);
  if (!target) {
    check('  · 选定验收目标包', false, '没有可读的资产包');
    return report();
  }
  console.log(`目标包：${target}\n`);

  const enc = encodeURIComponent(target);

  // 2. 结构
  const pkg = await get(`/package?id=${enc}`);
  check('GET /package', pkg.status === 200 && pkg.body.ok === true, `HTTP ${pkg.status}`);
  const ir = (pkg.body.value && pkg.body.value.ir) || {};
  check('  · 校验通过', pkg.body.value && pkg.body.value.ok === true, `problems=${((pkg.body.value || {}).problems || []).length}`);
  check('  · 有对象', Array.isArray(ir.objects) && ir.objects.length > 0, `${(ir.objects || []).length} 个`);
  check('  · 有 etag（可做乐观锁）', typeof pkg.body.value?.etag === 'string', pkg.body.value?.etag);

  // 3. 事实数据
  const records = await get(`/records?id=${enc}&limit=50`);
  const hasRecords = records.status === 200 && records.body.ok === true;
  check('GET /records', hasRecords, `HTTP ${records.status}`);
  if (hasRecords) {
    const objs = records.body.value.objects || [];
    const total = objs.reduce((n, o) => n + o.rows, 0);
    check('  · 事实数据行数', total > 0, `${total} 行 / ${objs.length} 个对象`);
  }

  // 4. 指标
  const metrics = await get(`/metrics?id=${enc}`);
  check('GET /metrics', metrics.status === 200 && metrics.body.ok === true, `HTTP ${metrics.status}`);
  const metricList = (metrics.body.value && metrics.body.value.metrics) || [];
  if (artifactHas(ir, 'metrics')) {
    check('  · 声明的指标都算出了结果或明确算不了', metricList.every((m) => m.value !== undefined), `${metricList.length} 个`);
    const bad = metricList.filter((m) => m.problems && m.problems.length);
    check('  · 没有算不了的指标', bad.length === 0, bad.map((m) => m.id).join(',') || '无');
    check('  · 每个指标都带参与行数', metricList.every((m) => typeof m.matched === 'number' && typeof m.total === 'number'), '');
  } else {
    check('  · 该包未声明指标（跳过）', true, '');
  }

  // 5. 视图
  const views = await get(`/views?id=${enc}`);
  check('GET /views', views.status === 200 && views.body.ok === true, `HTTP ${views.status}`);
  if (artifactHas(ir, 'views')) {
    const list = (views.body.value && views.body.value.views) || [];
    check('  · 视图覆盖信息完整', list.every((v) => Array.isArray(v.coverage) && v.coverage.length > 0), `${list.length} 个`);
    check('  · 全量统计存在', typeof views.body.value.total?.properties === 'number', views.body.value.total?.properties);
  } else {
    check('  · 该包未声明视图（跳过）', true, '');
  }

  // 6. 血缘
  const lineage = await get(`/lineage?id=${enc}`);
  check('GET /lineage', lineage.status === 200 && lineage.body.ok === true, `HTTP ${lineage.status}`);
  if (lineage.status === 200) {
    const cov = lineage.body.value.coverage || {};
    check('  · 覆盖率分母与实际属性数一致', cov.total === countProperties(ir), `${cov.total} vs ${countProperties(ir)}`);
    check('  · 断点有按属性列出', Array.isArray(lineage.body.value.gaps), `${(lineage.body.value.gaps || []).length} 处`);
  }

  // 7. 流程
  const plans = await get(`/process-plan?id=${enc}`);
  check('GET /process-plan', plans.status === 200 && plans.body.ok === true, `HTTP ${plans.status}`);
  if (artifactHas(ir, 'processes')) {
    const list = (plans.body.value && plans.body.value.plans) || [];
    check('  · 每个流程都推演出步骤判定', list.every((p) => p.ok === false || (Array.isArray(p.steps) && p.steps.length === stepCount(ir, p.id))), `${list.length} 个`);
    check('  · 卡住的流程说清卡在哪一步', list.every((p) => p.blockedAt === null || typeof p.blockedReason === 'string'), '');
  } else {
    check('  · 该包未声明流程（跳过）', true, '');
  }

  // 8. 执行轨迹摘要
  const traces = await get('/traces?limit=50');
  const tOk = traces.status === 200 && traces.body.ok === true;
  check('GET /traces', tOk, `HTTP ${traces.status}`);
  if (tOk) {
    const s = traces.body.value.summary || {};
    check('  · 摘要与条目数一致', s.total === (traces.body.value.entries || []).length, `total=${s.total}`);
    if (s.total > 0) check('  · 成功率是数字', typeof s.successRate === 'number', `${s.successRate}%`);
  }

  report();
})().catch((error) => {
  console.error('验收失败：', error && error.message);
  process.exit(2);
});

function artifactHas(ir, key) {
  return Array.isArray(ir[key]) && ir[key].length > 0;
}

function countProperties(ir) {
  return (ir.objects || []).reduce((n, o) => n + (o.properties || []).length, 0);
}

function stepCount(ir, processId) {
  const p = (ir.processes || []).find((x) => x.id === processId);
  return p ? p.steps.length : 0;
}

function report() {
  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) {
    console.log(`${c.ok ? '  ok  ' : '  FAIL'} ${c.name}${c.detail ? '  ' + c.detail : ''}`);
  }
  console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
  if (failed.length) {
    console.error('\n失败项：');
    for (const f of failed) console.error(' - ' + f.name + (f.detail ? '：' + f.detail : ''));
    // 用 exitCode 而不是 process.exit：fetch 的句柄还没关，硬退会在 Windows 上触发 libuv 断言
    process.exitCode = 1;
  }
}
