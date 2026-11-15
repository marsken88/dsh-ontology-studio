import { evaluateExpression } from './expr.mjs';

/**
 * Action input validation and declarative effects.
 *
 * An action says *what* it changes, never *how*: an effect names the target
 * object, the keys that locate a row, and the fields it sets or adjusts. `set`
 * copies an input value; `adjust` evaluates a small arithmetic expression over
 * the input (`-qty`, `qty * -1`) — still no arbitrary code, and the executor
 * remains the only thing that touches records.
 */
const NUMERIC = new Set(['number', 'integer', 'money']);
function typeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** @returns {{ ok: boolean, problems: Array<{field: string, code: string, message: string}>, value: object }} */
export function validateInput(action, input) {
  const problems = [];
  const schema = action.inputSchema;
  if (!Array.isArray(schema) || schema.length === 0) {
    return { ok: false, problems: [{ field: '$', code: 'no-schema', message: `动作 ${action.id} 没有声明 inputSchema，无法校验入参` }], value: {} };
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, problems: [{ field: '$', code: 'bad-input', message: 'input 必须是对象' }], value: {} };
  }

  const declared = new Set(schema.map((field) => field.name));
  for (const key of Object.keys(input)) {
    if (!declared.has(key)) {
      problems.push({ field: key, code: 'unknown-field', message: `入参里没有声明字段 ${key}` });
    }
  }

  const value = {};
  for (const field of schema) {
    const raw = input[field.name];
    if (raw === undefined || raw === null) {
      if (field.required === true) {
        problems.push({ field: field.name, code: 'required', message: `缺少必填入参 ${field.name}` });
      }
      continue;
    }
    if (field.type === 'enum') {
      const allowed = Array.isArray(field.enum) ? field.enum : [];
      if (!allowed.includes(raw)) {
        problems.push({ field: field.name, code: 'bad-enum', message: `${field.name} 只能是 ${allowed.join(' / ')}` });
        continue;
      }
    } else if (NUMERIC.has(field.type)) {
      if (typeof raw !== 'number' || Number.isNaN(raw)) {
        problems.push({ field: field.name, code: 'bad-type', message: `${field.name} 必须是数字` });
        continue;
      }
      if (field.type === 'integer' && !Number.isInteger(raw)) {
        problems.push({ field: field.name, code: 'bad-type', message: `${field.name} 必须是整数` });
        continue;
      }
      if (raw < 0) {
        problems.push({ field: field.name, code: 'out-of-range', message: `${field.name} 不能为负` });
        continue;
      }
    } else if (field.type === 'boolean') {
      if (typeof raw !== 'boolean') {
        problems.push({ field: field.name, code: 'bad-type', message: `${field.name} 必须是布尔值` });
        continue;
      }
    } else if (typeof raw !== 'string') {
      problems.push({ field: field.name, code: 'bad-type', message: `${field.name} 必须是字符串（收到 ${typeName(raw)}）` });
      continue;
    }
    value[field.name] = raw;
  }

  return { ok: problems.length === 0, problems, value };
}

/**
 * Apply an action's effect to a records container, mutating a *copy*.
 * @returns {{ matched: number, updated: number, changed: Array<object>, rows: object[] }}
 */
/** An action may declare one effect or several; normalize to a list. */
export function normalizeEffects(action) {
  const raw = action && action.effect;
  if (!raw) return [];
  return Array.isArray(raw) ? raw.filter(Boolean) : [raw];
}

/**
 * Apply one effect. `matchKeys` entries are either a field name shared with the
 * input, or `{ field, from }` when the input uses a different name
 * (a transfer matches `storeId` against `fromStoreId`).
 */
export function applyEffect(records, effect, input) {
  if (!effect) {
    return { matched: 0, updated: 0, changed: [], rows: [], missingEffect: true };
  }
  const allObjects = (records && records.objects) || {};
  if (!Array.isArray(allObjects[effect.object])) allObjects[effect.object] = [];
  const rows = allObjects[effect.object];

  let matched = 0;
  let updated = 0;
  const changed = [];

  for (const row of rows) {
    const hit = (effect.matchKeys || []).every((key) => {
      const spec = typeof key === 'string' ? { field: key, from: key } : key;
      return row[spec.field] === input[spec.from];
    });
    if (!hit) continue;
    matched += 1;
    const before = {};
    const after = {};

    for (const [field, source] of Object.entries(effect.set || {})) {
      const next = input[source];
      if (next === undefined || row[field] === next) continue;
      before[field] = row[field] === undefined ? null : row[field];
      row[field] = next;
      after[field] = next;
    }

    for (const [field, expression] of Object.entries(effect.adjust || {})) {
      const delta = evaluateExpression(expression, input);
      if (typeof delta !== 'number' || Number.isNaN(delta)) continue;
      const current = typeof row[field] === 'number' ? row[field] : 0;
      const next = current + delta;
      if (next === current) continue;
      before[field] = row[field] === undefined ? null : row[field];
      row[field] = next;
      after[field] = next;
    }

    if (Object.keys(after).length) {
      updated += 1;
      changed.push({ before, after });
    }
  }

  return { matched, updated, changed, rows };
}

/** Apply every declared effect, aggregating the report. */
export function applyEffects(records, action, input) {
  const effects = normalizeEffects(action);
  if (effects.length === 0) {
    return { matched: 0, updated: 0, changed: [], effects: [], missingEffect: true };
  }
  const reports = effects.map((effect) => {
    const report = applyEffect(records, effect, input);
    return { object: effect.object, matched: report.matched, updated: report.updated, changed: report.changed };
  });
  return {
    matched: reports.reduce((n, r) => n + r.matched, 0),
    updated: reports.reduce((n, r) => n + r.updated, 0),
    changed: reports.flatMap((r) => r.changed),
    effects: reports,
  };
}

/** Actions that can actually run: they declare both an input schema and an effect. */
export function executableActions(ir) {
  return (ir.actions || []).filter((a) => normalizeEffects(a).length > 0 && Array.isArray(a.inputSchema) && a.inputSchema.length > 0);
}

/** Policies that force approval for one action. */
export function policiesFor(ir, actionId) {
  return (ir.policies || []).filter((p) => (p.appliesTo || []).includes(actionId));
}
