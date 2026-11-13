/**
 * Rule evaluation against sample records.
 *
 * A rule carries only an expression (`availableQty < safetyStock`), no object
 * pointer. The owning object is therefore *derived*: the object whose declared
 * properties cover every identifier the expression reads. If no object covers
 * them, the rule is reported as unresolvable instead of being guessed at — a
 * rule that references `turnoverDays` when no object declares it does not
 * silently "pass".
 */
import { parse, evaluate, identifiersOf, UnknownIdentifierError, ParseError } from './expr.mjs';

/** @returns {{ rule: object, ast?: object, objectId?: string, identifiers: string[], reason?: string }} */
export function resolveRule(ir, rule) {
  let identifiers = [];
  let ast;
  try {
    ast = parse(rule.expression);
    identifiers = identifiersOf(ast);
  } catch (error) {
    return {
      rule,
      identifiers: [],
      reason: error instanceof ParseError ? `表达式无法解析：${error.message}` : `表达式无法解析：${error.message}`,
    };
  }

  const candidates = (ir.objects || []).filter((obj) => {
    const names = new Set((obj.properties || []).map((p) => p.name));
    return identifiers.every((name) => names.has(name));
  });

  if (candidates.length === 0) {
    const known = new Set();
    for (const obj of ir.objects || []) for (const p of obj.properties || []) known.add(p.name);
    const missing = identifiers.filter((name) => !known.has(name));
    return {
      rule,
      ast,
      identifiers,
      reason: missing.length
        ? `无法解析到对象：${missing.join(', ')} 不是任何对象的属性`
        : '无法解析到对象：没有对象同时包含这些属性',
    };
  }
  if (candidates.length > 1) {
    return {
      rule,
      ast,
      identifiers,
      reason: `属性同时被多个对象声明，无法判定归属：${candidates.map((o) => o.id).join(', ')}`,
    };
  }
  return { rule, ast, identifiers, objectId: candidates[0].id };
}

/**
 * Evaluate every rule against the record set.
 * @param {object} ir validated IR
 * @param {{ objects?: Record<string, object[]> }} records
 */
export function evaluateRules(ir, records) {
  const rows = (records && records.objects) || {};
  const results = [];
  const skipped = [];

  for (const rule of ir.rules || []) {
    const resolved = resolveRule(ir, rule);
    if (resolved.reason) {
      skipped.push({ rule: rule.id, reason: resolved.reason });
      continue;
    }
    const objectRows = rows[resolved.objectId] || [];
    const violations = [];
    let evaluated = 0;
    let errors = 0;

    objectRows.forEach((row, index) => {
      try {
        const value = evaluate(resolved.ast, row);
        evaluated += 1;
        if (value) {
          violations.push({
            row: index,
            values: pick(resolved.identifiers, row),
          });
        }
      } catch (error) {
        errors += 1;
        violations.push({
          row: index,
          error: error instanceof UnknownIdentifierError ? error.message : String(error && error.message),
        });
      }
    });

    results.push({
      rule: rule.id,
      name: rule.name,
      severity: rule.severity,
      enabled: rule.enabled !== false,
      object: resolved.objectId,
      identifiers: resolved.identifiers,
      evaluated,
      errors,
      violations,
      status: violations.length ? 'violations' : 'clean',
    });
  }

  const active = results.filter((r) => r.enabled);
  return {
    results,
    skipped,
    summary: {
      rules: (ir.rules || []).length,
      evaluated: active.length,
      disabled: results.length - active.length,
      unresolved: skipped.length,
      rows: Object.keys(rows).reduce((n, key) => n + rows[key].length, 0),
      violatingRules: active.filter((r) => r.violations.length).length,
      violations: active.reduce((n, r) => n + r.violations.length, 0),
    },
  };
}

function pick(names, row) {
  const out = {};
  for (const name of names) out[name] = row[name];
  return out;
}
