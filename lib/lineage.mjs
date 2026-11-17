/**
 * 数据血缘：从物理列到下游产物的一条可查的链。
 *
 * 它回答三个具体问题：
 *   1. 每个属性接到哪个物理列了（storage），没接的还有多少
 *   2. 一个属性被谁用着：规则、指标、动作、视图、流程
 *   3. **断点**：没有 storage 映射、却仍被规则/指标消费的属性——
 *      这类属性在真实数据上根本跑不起来，而面板上看起来一切正常
 *
 * 第三个是这套东西真正的用处。覆盖率 100% 只是一个数字，「哪条规则接不到
 * 真实数据」才是一个能去修的问题。
 *
 * 纯函数，不碰文件系统。
 */
import { resolveRule } from './rules.mjs';
import { parse, identifiersOf } from './expr.mjs';

const KIND_LABEL = { rule: '规则', metric: '指标', action: '动作', view: '视图', process: '流程' };

/** 一个过滤/表达式里的标识符；解析不了就当空，不要让血缘整体崩掉。 */
function identifiers(expression) {
  if (typeof expression !== 'string' || expression.trim() === '') return [];
  try {
    return identifiersOf(parse(expression));
  } catch {
    return [];
  }
}

export function buildLineage(ir) {
  const objects = Array.isArray(ir.objects) ? ir.objects : [];
  const rules = Array.isArray(ir.rules) ? ir.rules : [];
  const metrics = Array.isArray(ir.metrics) ? ir.metrics : [];
  const actions = Array.isArray(ir.actions) ? ir.actions : [];
  const views = Array.isArray(ir.views) ? ir.views : [];
  const processes = Array.isArray(ir.processes) ? ir.processes : [];

  /** objectId -> property -> [{kind, id}] */
  const consumers = new Map();
  const addConsumer = (objectId, property, kind, id) => {
    if (!consumers.has(objectId)) consumers.set(objectId, new Map());
    const byProp = consumers.get(objectId);
    if (!byProp.has(property)) byProp.set(property, []);
    const list = byProp.get(property);
    if (!list.some((c) => c.kind === kind && c.id === id)) list.push({ kind, id });
  };

  // 规则：按归属对象 + 表达式里出现的属性
  const ruleOwner = new Map();
  for (const rule of rules) {
    const resolved = resolveRule(ir, rule);
    if (!resolved.objectId) continue;
    ruleOwner.set(rule.id, resolved.objectId);
    for (const name of resolved.identifiers || []) addConsumer(resolved.objectId, name, 'rule', rule.id);
  }

  // 指标：目标字段 + 过滤表达式里的属性
  for (const metric of metrics) {
    if (!metric || !metric.object) continue;
    if (metric.field) addConsumer(metric.object, metric.field, 'metric', metric.id);
    for (const name of identifiers(metric.filter)) addConsumer(metric.object, name, 'metric', metric.id);
  }

  // 动作：effect 碰到的属性（set / adjust / matchKeys）
  for (const action of actions) {
    const effects = Array.isArray(action.effect) ? action.effect : action.effect ? [action.effect] : [];
    for (const effect of effects) {
      if (!effect || !effect.object) continue;
      const touched = [
        ...Object.keys(effect.set || {}),
        ...Object.keys(effect.adjust || {}),
        ...(effect.matchKeys || []).map((k) => (typeof k === 'string' ? k : k && k.field)),
      ].filter(Boolean);
      for (const name of touched) addConsumer(effect.object, name, 'action', action.id);
    }
  }

  // 视图：明确列出来的属性
  for (const view of views) {
    for (const entry of view.objects || []) {
      for (const name of entry.properties || []) addConsumer(entry.objectId, name, 'view', view.id);
    }
  }

  // 流程：通过它引用的规则/指标/动作间接消费
  for (const process of processes) {
    for (const step of process.steps || []) {
      if (step.kind === 'action') {
        const action = actions.find((a) => a.id === step.actionId);
        const effects = action ? (Array.isArray(action.effect) ? action.effect : action.effect ? [action.effect] : []) : [];
        for (const effect of effects) {
          if (!effect || !effect.object) continue;
          const touched = [
            ...Object.keys(effect.set || {}),
            ...Object.keys(effect.adjust || {}),
            ...(effect.matchKeys || []).map((k) => (typeof k === 'string' ? k : k && k.field)),
          ].filter(Boolean);
          for (const name of touched) addConsumer(effect.object, name, 'process', process.id);
        }
      }
      if (step.kind === 'check' && step.metricId) {
        const metric = metrics.find((m) => m.id === step.metricId);
        if (metric && metric.object) {
          if (metric.field) addConsumer(metric.object, metric.field, 'process', process.id);
          for (const name of identifiers(metric.filter)) addConsumer(metric.object, name, 'process', process.id);
        }
      }
      if (step.kind === 'check' && step.ruleId) {
        const owner = ruleOwner.get(step.ruleId);
        if (!owner) continue;
        const rule = rules.find((r) => r.id === step.ruleId);
        const resolved = rule ? resolveRule(ir, rule) : null;
        for (const name of (resolved && resolved.identifiers) || []) addConsumer(owner, name, 'process', process.id);
      }
    }
  }

  const columns = [];
  const gaps = [];
  const orphans = [];
  const detail = [];
  let total = 0;
  let mapped = 0;

  for (const object of objects) {
    for (const property of object.properties || []) {
      total += 1;
      const used = (consumers.get(object.id) || new Map()).get(property.name) || [];
      const storage = property.storage || null;
      if (storage) mapped += 1;
      for (const consumer of used) {
        detail.push({
          objectId: object.id,
          property: property.name,
          storage,
          kind: consumer.kind,
          kindLabel: KIND_LABEL[consumer.kind] || consumer.kind,
          id: consumer.id,
        });
      }
      if (storage) {
        columns.push({
          objectId: object.id,
          property: property.name,
          storage,
          type: property.type,
          indexed: property.indexed === true,
          consumers: used.length,
        });
      } else if (used.length) {
        // 断点：接不到物理列，却有人在读它
        gaps.push({
          objectId: object.id,
          property: property.name,
          usedBy: used.map((c) => `${KIND_LABEL[c.kind] || c.kind} ${c.id}`),
        });
      } else {
        orphans.push({ objectId: object.id, property: property.name });
      }
    }
  }

  return {
    coverage: {
      total,
      mapped,
      unmapped: total - mapped,
      percent: total ? Math.round((mapped / total) * 1000) / 10 : 0,
    },
    columns,
    gaps,
    orphans,
    detail,
    objects: objects.length,
  };
}

/** 一句话说清血缘状况，面板与工具共用。 */
export function describeLineage(lineage) {
  if (!lineage || !lineage.coverage.total) return '没有可查的属性';
  const c = lineage.coverage;
  const bits = [`${c.mapped}/${c.total} 个属性接上了物理列（${c.percent}%）`];
  if (lineage.gaps.length) {
    bits.push(`${lineage.gaps.length} 处断点：有下游在读，但属性没有物理列`);
  } else {
    bits.push('没有断点');
  }
  if (lineage.orphans.length) bits.push(`${lineage.orphans.length} 个属性既没有物理列也没人读`);
  return bits.join('，');
}
