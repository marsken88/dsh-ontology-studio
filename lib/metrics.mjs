/**
 * 指标口径：把「业务上怎么算一个数」声明下来，并在事实数据上真的算出来。
 *
 * 与规则的分工：规则判断一行合不合规（产出违规列表），指标是对一批行做聚合
 * （产出数字）。两者都跑在同一份 *.records.json 上。
 *
 * 刻意不做的：不做时间窗口、不做多维下钻、不做同比环比——那需要时间序列和
 * 历史快照，示例事实数据里没有。声明里也不编这些字段，免得看起来支持。
 */
import { parse, evaluate, identifiersOf } from './expr.mjs';

const AGGREGATIONS = new Set(['count', 'sum', 'avg', 'min', 'max']);
const NUMERIC_TYPES = new Set(['number', 'integer', 'money']);

export function aggregations() {
  return [...AGGREGATIONS];
}

/** 一个指标是否可算：对象、字段、聚合方式、过滤表达式都要对得上。 */
export function checkMetric(ir, metric) {
  const problems = [];
  const objects = Array.isArray(ir && ir.objects) ? ir.objects : [];
  const object = objects.find((o) => o.id === metric.object);
  if (!object) {
    problems.push({ field: 'object', code: 'dangling-object', message: `指标指向的对象不存在：${String(metric.object)}` });
    return { ok: false, problems, object: null, field: null, filter: null };
  }

  if (!AGGREGATIONS.has(metric.aggregation)) {
    problems.push({
      field: 'aggregation',
      code: 'bad-enum',
      message: `聚合方式只能是 ${[...AGGREGATIONS].join(' | ')}，收到：${String(metric.aggregation)}`,
    });
  }

  const props = new Map((object.properties || []).map((p) => [p.name, p]));
  let field = null;
  if (metric.aggregation !== 'count' || metric.field !== undefined) {
    const hit = props.get(metric.field);
    if (!hit) {
      problems.push({ field: 'field', code: 'dangling-field', message: `${object.id} 没有属性：${String(metric.field)}` });
    } else {
      field = hit;
      if (metric.aggregation !== 'count' && !NUMERIC_TYPES.has(hit.type)) {
        problems.push({
          field: 'field',
          code: 'non-numeric',
          message: `${hit.name} 的类型是 ${hit.type}，不能做 ${metric.aggregation}`,
        });
      }
    }
  }

  let filter = null;
  if (metric.filter !== undefined) {
    if (typeof metric.filter !== 'string' || metric.filter.trim() === '') {
      problems.push({ field: 'filter', code: 'bad-type', message: 'filter 必须是非空表达式字符串' });
    } else {
      try {
        const ast = parse(metric.filter);
        const used = identifiersOf(ast);
        const unknown = used.filter((name) => !props.has(name));
        if (unknown.length) {
          problems.push({
            field: 'filter',
            code: 'dangling-identifier',
            message: `${object.id} 没有这些属性：${unknown.join('、')}`,
          });
        }
        filter = ast;
      } catch (error) {
        problems.push({ field: 'filter', code: 'bad-expression', message: `过滤表达式无法解析：${error.message}` });
      }
    }
  }

  return { ok: problems.length === 0, problems, object, field, filter };
}

/**
 * 在事实数据上算一个指标。
 *
 * 返回里带 matched（参与计算的行数）与 total（对象总行数）——
 * 「0 行参与计算」和「结果是 0」必须能分开看，否则一个空表会被读成业绩归零。
 */
export function computeMetric(ir, records, metric) {
  const checked = checkMetric(ir, metric);
  if (!checked.ok) {
    return {
      id: metric.id,
      ok: false,
      value: null,
      matched: 0,
      total: 0,
      problems: checked.problems,
    };
  }

  const rows = (records && records.objects && Array.isArray(records.objects[metric.object])
    ? records.objects[metric.object]
    : []);

  let matched = rows;
  if (checked.filter) {
    matched = rows.filter((row) => {
      try {
        return Boolean(evaluate(checked.filter, row));
      } catch {
        return false; // 某一行算不了就跳过这一行，不整条指标失败
      }
    });
  }

  const values = checked.field
    ? matched.map((row) => row[metric.field]).filter((v) => v !== undefined && v !== null && v !== '')
    : matched;

  let value = null;
  if (metric.aggregation === 'count') {
    value = metric.field === undefined ? matched.length : values.length;
  } else if (values.length) {
    const numbers = values.map((v) => Number(v)).filter((n) => Number.isFinite(n));
    if (numbers.length) {
      if (metric.aggregation === 'sum') value = numbers.reduce((a, b) => a + b, 0);
      else if (metric.aggregation === 'avg') value = Math.round((numbers.reduce((a, b) => a + b, 0) / numbers.length) * 100) / 100;
      else if (metric.aggregation === 'min') value = Math.min(...numbers);
      else if (metric.aggregation === 'max') value = Math.max(...numbers);
    }
  }

  return {
    id: metric.id,
    name: metric.name,
    object: metric.object,
    aggregation: metric.aggregation,
    field: metric.field === undefined ? null : metric.field,
    filter: metric.filter === undefined ? null : metric.filter,
    value,
    matched: matched.length,
    total: rows.length,
    problems: [],
  };
}

/**
 * 删掉一个对象之后清理指标：指向它的口径直接删掉。
 * 留着会变成一条永远算不出来的口径，而且整包校验过不了。
 * @returns {string[]} 被删掉的指标 id
 */
export function trimMetricsAfterObjectDelete(ir, objectId) {
  const metrics = Array.isArray(ir.metrics) ? ir.metrics : [];
  if (!metrics.length) return [];
  const removed = metrics.filter((m) => m && m.object === objectId).map((m) => m.id);
  ir.metrics = metrics.filter((m) => !m || m.object !== objectId);
  return removed;
}

/** 整包所有指标；声明有问题的也会出现，值为 null 并带上原因。 */
export function computeMetrics(ir, records) {
  const metrics = Array.isArray(ir && ir.metrics) ? ir.metrics : [];
  return metrics.map((metric) => computeMetric(ir, records, metric));
}

/** 一句话描述一个指标口径。 */
export function describeMetric(metric) {
  const agg = { count: '计数', sum: '求和', avg: '均值', min: '最小', max: '最大' }[metric.aggregation] || metric.aggregation;
  const target = metric.field ? `${metric.object}.${metric.field}` : metric.object;
  return metric.filter ? `${target} ${agg}（仅统计 ${metric.filter} 的行）` : `${target} ${agg}`;
}

/** 一句话说清结果，带上「多少行参与」，避免把空表读成 0。 */
export function describeResult(result) {
  if (!result || result.ok === false) {
    const first = (result && result.problems && result.problems[0]) || null;
    return `${(result && result.id) || '指标'} 算不了：${first ? first.message : '未知原因'}`;
  }
  if (result.value === null) {
    return `${result.id} = —（${result.matched} 行参与计算，没有可用的数值）`;
  }
  return `${result.id} = ${result.value}（${result.matched}/${result.total} 行参与计算）`;
}
