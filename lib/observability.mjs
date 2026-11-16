/**
 * 从执行轨迹算调用层面的指标。
 *
 * 只算轨迹里真的有的东西：调用次数、成功率、耗时分布、哪个工具最容易失败。
 * 不算「补货准确率」这类业务指标——那需要把业务结果回写，轨迹里没有这个信息，
 * 硬算出来的数只会比演示数据更危险（它看起来是真的）。
 *
 * 纯函数：输入轨迹数组，输出一个摘要，不碰文件系统。
 */

/** 线性插值分位数：结果落在 [最小值, 最大值] 内，不外推到样本之外。 */
export function percentile(sorted, q) {
  const list = (sorted || []).filter((n) => Number.isFinite(n));
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  const pos = (list.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return list[lo];
  return Math.round(list[lo] + (list[hi] - list[lo]) * (pos - lo));
}

/**
 * @param {Array<{ts?: number, tool?: string, ok?: boolean, ms?: number}>} entries
 */
export function summarizeTraces(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && typeof e === 'object');
  const total = list.length;
  if (!total) {
    return {
      total: 0,
      ok: 0,
      failed: 0,
      successRate: null,
      avgMs: null,
      p50Ms: null,
      p95Ms: null,
      slowestMs: null,
      tools: [],
      topFailing: [],
      firstAt: null,
      lastAt: null,
    };
  }

  const ok = list.filter((e) => e.ok !== false).length;
  const durations = list
    .map((e) => Number(e.ms))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  const byTool = new Map();
  for (const entry of list) {
    const name = String(entry.tool || 'unknown');
    const hit = byTool.get(name) || { tool: name, calls: 0, fails: 0, ms: 0 };
    hit.calls += 1;
    if (entry.ok === false) hit.fails += 1;
    hit.ms += Number.isFinite(Number(entry.ms)) ? Number(entry.ms) : 0;
    byTool.set(name, hit);
  }
  const tools = [...byTool.values()]
    .map((t) => ({
      tool: t.tool,
      calls: t.calls,
      fails: t.fails,
      successRate: Math.round(((t.calls - t.fails) / t.calls) * 1000) / 10,
      avgMs: Math.round(t.ms / t.calls),
    }))
    .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));

  const timestamps = list.map((e) => Number(e.ts)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);

  return {
    total,
    ok,
    failed: total - ok,
    successRate: Math.round((ok / total) * 1000) / 10,
    avgMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    slowestMs: durations.length ? durations[durations.length - 1] : null,
    tools,
    topFailing: tools
      .filter((t) => t.fails > 0)
      .sort((a, b) => b.fails - a.fails || a.tool.localeCompare(b.tool))
      .slice(0, 3),
    firstAt: timestamps.length ? timestamps[0] : null,
    lastAt: timestamps.length ? timestamps[timestamps.length - 1] : null,
  };
}

/** 一句话描述，面板与工具共用；说清楚「这里没有业务指标」。 */
export function describeTraces(summary) {
  if (!summary || !summary.total) return '还没有任何工具调用记录';
  const bits = [`${summary.total} 次调用`, `成功率 ${summary.successRate}%`];
  if (summary.avgMs !== null) bits.push(`平均 ${summary.avgMs}ms`);
  if (summary.p95Ms !== null) bits.push(`P95 ${summary.p95Ms}ms`);
  if (summary.topFailing.length) {
    bits.push('最常失败：' + summary.topFailing.map((t) => `${t.tool} ${t.fails} 次`).join('、'));
  }
  bits.push('（业务结果类指标不在轨迹里，没有就是没有）');
  return bits.join('，');
}
