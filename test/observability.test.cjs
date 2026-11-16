/**
 * 调用层面指标的纯函数测试。
 *
 * 重点不是「算得对」，而是「不该有的东西不要造出来」：
 * 样本为空返回 null 而不是 0%，没有失败就不编一个「最常失败」。
 */
const assert = require('node:assert/strict');

const SUITE = require('node:path').join(__dirname, '..', 'lib', 'observability.mjs');

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
  const { summarizeTraces, describeTraces, percentile } = await import('file://' + SUITE);

  const trace = (tool, ok, ms, ts) => ({ tool, ok, ms, ts: ts || 1700000000000 });

  console.log('\n空输入');

  await it('没有轨迹时给 null，而不是 0% 或 0ms', () => {
    const s = summarizeTraces([]);
    assert.equal(s.total, 0);
    assert.equal(s.successRate, null);
    assert.equal(s.avgMs, null);
    assert.equal(s.p50Ms, null);
    assert.deepEqual(s.tools, []);
    assert.deepEqual(s.topFailing, []);
    assert.equal(s.firstAt, null);
  });

  await it('空输入的描述是「还没有记录」，不是「成功率 0%」', () => {
    assert.equal(describeTraces(summarizeTraces([])), '还没有任何工具调用记录');
  });

  console.log('\n基本统计');

  await it('成功率、平均耗时、P50/P95 都对', () => {
    const s = summarizeTraces([
      trace('ontology_get', true, 10),
      trace('ontology_get', true, 20),
      trace('ontology_list', false, 30),
      trace('ontology_publish', true, 40),
    ]);
    assert.equal(s.total, 4);
    assert.equal(s.ok, 3);
    assert.equal(s.failed, 1);
    assert.equal(s.successRate, 75);
    assert.equal(s.avgMs, 25);
    assert.equal(s.slowestMs, 40);
    assert.ok(s.p50Ms >= 20 && s.p50Ms <= 30, 'P50 应落在中间样本之间，实际 ' + s.p50Ms);
    assert.ok(s.p95Ms >= 30 && s.p95Ms <= 40, 'P95 应落在最大两个样本之间，实际 ' + s.p95Ms);
  });

  await it('按工具聚合，调用多的排前面', () => {
    const s = summarizeTraces([
      trace('a', true, 10),
      trace('b', true, 10),
      trace('a', false, 10),
      trace('a', true, 10),
    ]);
    assert.equal(s.tools[0].tool, 'a');
    assert.equal(s.tools[0].calls, 3);
    assert.equal(s.tools[0].fails, 1);
    assert.equal(s.tools[0].successRate, 66.7);
  });

  await it('没有失败时 topFailing 是空的，不硬凑一个', () => {
    const s = summarizeTraces([trace('a', true, 10), trace('b', true, 10)]);
    assert.deepEqual(s.topFailing, []);
    assert.match(describeTraces(s), /成功率 100%/);
  });

  await it('只有失败的工具才会进 topFailing，最多三个', () => {
    const s = summarizeTraces([
      trace('a', false, 1),
      trace('a', false, 1),
      trace('b', false, 1),
      trace('c', false, 1),
      trace('d', false, 1),
      trace('ok', true, 1),
    ]);
    assert.equal(s.topFailing.length, 3);
    assert.equal(s.topFailing[0].tool, 'a');
    assert.equal(s.topFailing[0].fails, 2);
  });

  await it('缺少 ms 的条目不会把平均值算坏', () => {
    const s = summarizeTraces([trace('a', true, 10), { tool: 'b', ok: true }]);
    assert.equal(s.avgMs, 10, '只对有时长的条目求平均');
    assert.equal(s.total, 2);
  });

  await it('时间范围取最早与最晚', () => {
    const s = summarizeTraces([trace('a', true, 1, 300), trace('a', true, 1, 100), trace('a', true, 1, 200)]);
    assert.equal(s.firstAt, 100);
    assert.equal(s.lastAt, 300);
  });

  console.log('\n描述');

  await it('描述里带调用数、成功率、耗时，并说明业务指标不在其中', () => {
    const line = describeTraces(summarizeTraces([trace('a', true, 12), trace('b', false, 8)]));
    assert.match(line, /2 次调用/);
    assert.match(line, /成功率 50%/);
    assert.match(line, /平均 10ms/);
    assert.match(line, /业务结果类指标不在轨迹里/);
  });

  await it('percentile 对单样本与空数组都不炸', () => {
    assert.equal(percentile([5], 0.5), 5);
    assert.equal(percentile([], 0.5), null);
    assert.equal(percentile([1, 2, 3, 4], 0.5), 3);
  });

  const total = pass + failures.length;
  console.log(`\n${pass}/${total} passed`);
  if (failures.length) {
    for (const f of failures) console.error('\n' + f.name + '\n', f.error);
    process.exit(1);
  }
})().catch((err) => {
  console.error('FAIL', err && err.stack);
  process.exit(1);
});
