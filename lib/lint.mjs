/**
 * Team conventions on top of the IR schema.
 *
 * The validator enforces what makes a package *loadable*. Conventions like
 * "object ids must carry the domain prefix" are local policy, so they live in
 * configuration instead of code — `config.lintRules`. They are advisory: they
 * show up in `ontology_validate` but never block a write, because a convention
 * should not be able to wedge the platform.
 */

const TARGETS = new Set(['package', 'object', 'property', 'action', 'rule', 'agent']);

/** Flatten a package into the nodes a lint rule can look at. */
function nodesOf(ir) {
  const nodes = [{ target: 'package', id: ir.id, node: ir }];
  for (const object of ir.objects || []) {
    nodes.push({ target: 'object', id: object.id, node: object });
    for (const property of object.properties || []) {
      nodes.push({ target: 'property', id: object.id + '.' + property.name, node: property });
    }
  }
  for (const action of ir.actions || []) nodes.push({ target: 'action', id: action.id, node: action });
  for (const rule of ir.rules || []) nodes.push({ target: 'rule', id: rule.id, node: rule });
  for (const agent of ir.agents || []) nodes.push({ target: 'agent', id: agent.id, node: agent });
  return nodes;
}

/**
 * @param {object} ir validated package
 * @param {Array<{id: string, target?: string, field?: string, pattern?: string, message?: string, equals?: unknown}>} rules
 * @returns {Array<{code: string, path: string, message: string}>}
 */
export function applyLint(ir, rules) {
  if (!Array.isArray(rules) || rules.length === 0) return [];
  const problems = [];
  const nodes = nodesOf(ir);

  for (const rule of rules) {
    if (!rule || typeof rule.id !== 'string' || rule.id === '') {
      problems.push({ code: 'lint-rule-invalid', path: '$.lintRules', message: '自定义校验缺少 id，已跳过' });
      continue;
    }
    const target = rule.target || 'object';
    if (!TARGETS.has(target)) {
      problems.push({ code: 'lint-rule-invalid', path: '$.lintRules', message: `${rule.id}：target 只能是 ${[...TARGETS].join('/')}` });
      continue;
    }
    if (rule.pattern !== undefined && typeof rule.pattern !== 'string') {
      problems.push({ code: 'lint-rule-invalid', path: '$.lintRules', message: `${rule.id}：pattern 必须是字符串` });
      continue;
    }
    let regex = null;
    if (rule.pattern) {
      try {
        regex = new RegExp(rule.pattern);
      } catch (error) {
        problems.push({ code: 'lint-rule-invalid', path: '$.lintRules', message: `${rule.id}：正则无法编译（${error.message}）` });
        continue;
      }
    }

    for (const entry of nodes) {
      if (entry.target !== target) continue;
      const field = rule.field || 'id';
      const value = entry.node[field];
      if (value === undefined) continue;
      if (regex && !regex.test(String(value))) {
        problems.push({
          code: 'lint:' + rule.id,
          path: `$.${target}.${entry.id}.${field}`,
          message: rule.message || `${entry.id}.${field} 不满足 /${rule.pattern}/`,
        });
      }
      if (rule.equals !== undefined && value !== rule.equals) {
        problems.push({
          code: 'lint:' + rule.id,
          path: `$.${target}.${entry.id}.${field}`,
          message: rule.message || `${entry.id}.${field} 必须等于 ${JSON.stringify(rule.equals)}`,
        });
      }
    }
  }
  return problems;
}
