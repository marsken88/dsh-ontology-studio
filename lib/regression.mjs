/**
 * Regression planning: what to re-check after changing one object.
 *
 * `impactOf` answers "what points at this object". A regression plan answers the
 * next question: "so what exactly do I have to re-verify, and how". Every item is
 * concrete enough to run — a rule to re-evaluate, an action to re-execute, a
 * route to re-fetch — instead of "check everything".
 */

/** Which rules reference one of the object's properties. */
function rulesTouching(ir, object) {
  const names = (object.properties || []).map((p) => p.name);
  return (ir.rules || []).filter((rule) => {
    const expression = String(rule.expression || '');
    return names.some((name) => new RegExp('\\b' + name + '\\b').test(expression));
  });
}

/**
 * @param {object} ir validated package
 * @param {string} objectId
 * @param {{ change?: string }} options
 */
export function buildRegressionPlan(ir, objectId, options = {}) {
  const object = (ir.objects || []).find((o) => o.id === objectId);
  if (!object) return null;

  const items = [];
  const add = (kind, title, detail, how) => items.push({ kind, title, detail, how });

  const properties = (object.properties || []).length;
  add('object', `重新校验 ${object.id}`, `${properties} 个属性，主键 ${(object.keys || []).join('+') || '未声明'}`, 'ontology_validate');

  const rules = rulesTouching(ir, object);
  if (rules.length) {
    add(
      'rules',
      `${rules.length} 条规则需要在示例数据上重跑`,
      rules.map((r) => `${r.id}（${r.severity}${r.enabled === false ? '，已停用' : ''}）`).join('、'),
      `ontology_evaluate_rules({ packageId: "${ir.id}" })`
    );
  } else {
    add('rules', '没有规则引用这个对象', '改动不影响规则求值', '—');
  }

  const actions = (ir.actions || []).filter((a) => (a.writes || []).includes(objectId));
  for (const action of actions) {
    const executable = Boolean(action.effect && Array.isArray(action.inputSchema) && action.inputSchema.length);
    add(
      'action',
      `${action.id} 需要重跑`,
      executable
        ? `${action.name}${action.approvalRequired ? '（需审批）' : ''}，会写 ${(action.writes || []).join(', ')}`
        : `${action.name} 只有声明，无法执行`,
      executable ? `ontology_execute_action(dryRun) 先预览，再真跑` : '—'
    );
  }

  const incoming = (ir.links || []).filter((l) => l.target === objectId);
  const outgoing = (ir.links || []).filter((l) => l.source === objectId);
  if (incoming.length || outgoing.length) {
    add(
      'links',
      '关系需要复查',
      `出向 ${outgoing.length} 条、入向 ${incoming.length} 条`,
      `ontology_impact({ packageId: "${ir.id}", objectId: "${objectId}" })`
    );
  }

  const agents = (ir.agents || []).filter((a) => (a.usesObjects || []).includes(objectId));
  for (const agent of agents) {
    add(
      'agent',
      `${agent.name} 依赖这个对象`,
      `状态 ${agent.status || 'draft'}${agent.evalTarget ? '，评测口径：' + agent.evalTarget : ''}`,
      '按该 Agent 的口径跑一次真实任务'
    );
  }

  const apps = (ir.actions || []).length;
  void apps;
  add('export', '导出的产物需要重新生成', 'JSON Schema / 文档都会随之变化', `ontology_export({ format: "markdown" })`);

  return {
    packageId: ir.id,
    objectId,
    change: options.change || null,
    propertyCount: properties,
    items,
    summary: {
      total: items.length,
      rules: rules.length,
      actions: actions.length,
      agents: agents.length,
      links: incoming.length + outgoing.length,
    },
  };
}
