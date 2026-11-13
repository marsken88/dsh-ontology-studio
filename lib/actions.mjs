/**
 * Action input validation and declarative effects.
 *
 * An action says *what* it changes, never *how*: `effect` names the target
 * object, the keys that locate a row, and the fields it sets from input. That
 * keeps an asset file from carrying executable code and keeps the executor the
 * only thing that touches records.
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
export function applyEffect(records, action, input) {
  const effect = action.effect;
  if (!effect) {
    return { matched: 0, updated: 0, changed: [], rows: [], missingEffect: true };
  }
  const allObjects = (records && records.objects) || {};
  const rows = Array.isArray(allObjects[effect.object]) ? allObjects[effect.object] : [];
  if (!Array.isArray(allObjects[effect.object])) allObjects[effect.object] = rows;

  let matched = 0;
  let updated = 0;
  const changed = [];

  for (const row of rows) {
    const hit = effect.matchKeys.every((key) => row[key] === input[key]);
    if (!hit) continue;
    matched += 1;
    const before = {};
    const after = {};
    for (const [field, source] of Object.entries(effect.set)) {
      before[field] = row[field];
      const next = input[source];
      if (next === undefined) continue;
      if (row[field] === next) continue;
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

/** Actions that can actually run: they declare both an input schema and an effect. */
export function executableActions(ir) {
  return (ir.actions || []).filter((a) => a.effect && Array.isArray(a.inputSchema) && a.inputSchema.length > 0);
}

/** Policies that force approval for one action. */
export function policiesFor(ir, actionId) {
  return (ir.policies || []).filter((p) => (p.appliesTo || []).includes(actionId));
}
