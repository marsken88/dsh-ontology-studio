/**
 * Evaluation runs: how a rule set behaves, and whether two runs may be compared.
 *
 * The discipline comes from Harness²'s experiment guide: a comparison is only
 * meaningful when the conditions match. Here the conditions are the package, the
 * rule set, and the fact data. Anything else has to be refused rather than
 * quietly reported as "improvement".
 */
import { createHash } from 'node:crypto';
import { evaluateRules } from './rules.mjs';

/** Content fingerprint for one part of the conditions. */
export function digest(value) {
  return 'sha256-' + createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex').slice(0, 16);
}

/**
 * Run every rule over the records and shape the result as one comparable run.
 * @param {object} ir package
 * @param {object} records fact data
 * @param {{ packageFile?: string, recordsFile?: string }} meta
 */
export function runEvaluation(ir, records, meta = {}) {
  const evaluated = evaluateRules(ir, records);
  const byRule = evaluated.results.map((r) => ({
    rule: r.rule,
    object: r.object,
    enabled: r.enabled,
    evaluated: r.evaluated,
    errors: r.errors,
    violations: r.violations.length,
  }));

  return {
    id: 'run-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36),
    ts: Date.now(),
    packageId: ir.id,
    packageVersion: ir.version,
    // The three conditions a comparison has to hold constant.
    conditions: {
      packageId: ir.id,
      rules: digest(ir.rules || []),
      data: digest(records || {}),
    },
    rows: evaluated.summary.rows,
    evaluated: evaluated.summary.evaluated,
    violations: evaluated.summary.violations,
    violatingRules: evaluated.summary.violatingRules,
    unresolved: evaluated.summary.unresolved,
    byRule,
    skipped: (evaluated.skipped || []).map((s) => ({ rule: s.rule, reason: s.reason })),
    files: { package: meta.packageFile || null, records: meta.recordsFile || null },
  };
}

/**
 * Compare two runs, refusing when the conditions differ in a way that makes the
 * delta meaningless. The interesting cases are "same rules, new data" and
 * "changed rules, same data" — both are legitimate; changing both is not.
 */
export function compareRuns(a, b) {
  if (!a || !b) {
    return { comparable: false, reason: '缺少要对比的两次运行' };
  }
  if (a.packageId !== b.packageId) {
    return {
      comparable: false,
      reason: `不同的资产包（${a.packageId} vs ${b.packageId}），结果不可比`,
      differs: ['packageId'],
    };
  }

  const sameRules = a.conditions.rules === b.conditions.rules;
  const sameData = a.conditions.data === b.conditions.data;
  const differs = [];
  if (!sameRules) differs.push('rules');
  if (!sameData) differs.push('data');

  if (!sameRules && !sameData) {
    return {
      comparable: false,
      reason: '规则和数据同时变了，无法判断差异来自哪一边——请固定其中一个再跑',
      differs,
    };
  }

  const deltaOf = (field) => (b[field] || 0) - (a[field] || 0);
  const perRule = [];
  const seen = new Set();
  for (const before of a.byRule) {
    const after = b.byRule.find((r) => r.rule === before.rule);
    seen.add(before.rule);
    perRule.push({
      rule: before.rule,
      before: before.violations,
      after: after ? after.violations : 0,
      delta: (after ? after.violations : 0) - before.violations,
      status: after ? 'common' : 'removed',
    });
  }
  for (const after of b.byRule) {
    if (seen.has(after.rule)) continue;
    perRule.push({ rule: after.rule, before: 0, after: after.violations, delta: after.violations, status: 'added' });
  }

  return {
    comparable: true,
    varies: sameRules ? '数据变了（规则未变）' : '规则变了（数据未变）',
    from: { id: a.id, ts: a.ts, version: a.packageVersion },
    to: { id: b.id, ts: b.ts, version: b.packageVersion },
    delta: {
      violations: deltaOf('violations'),
      violatingRules: deltaOf('violatingRules'),
      unresolved: deltaOf('unresolved'),
      rows: deltaOf('rows'),
    },
    perRule,
  };
}
