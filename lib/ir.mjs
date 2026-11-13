/**
 * Ontology IR — pure validation and analysis helpers.
 *
 * `assets/ontology-ir.schema.json` describes the shape; the checks here cover
 * what a JSON Schema cannot express: cross references between entities
 * (link endpoints, key properties, action writes, policy targets) and
 * registry-wide uniqueness across packages.
 *
 * No dependencies, no I/O — callers pass parsed objects in.
 */

const IR_VERSION = /^\d+\.\d+\.\d+$/;
const PACKAGE_ID = /^[a-z][a-z0-9]*(\.[a-z0-9-]+)+$/;
const OBJECT_ID = /^[A-Z][A-Za-z0-9]*$/;
const PROPERTY_NAME = /^[a-z][A-Za-z0-9]*$/;
const LINK_ID = /^[a-z][a-z0-9_]*$/;
const QUALIFIED_ID = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/;
const ACTION_ID = /^[a-z][A-Za-z0-9]*$/;

const PROPERTY_TYPES = new Set([
  'string', 'number', 'integer', 'boolean', 'date', 'datetime', 'money', 'enum', 'json',
]);
const CARDINALITIES = new Set(['1:1', '1:n', 'n:1', 'n:m']);
const SEVERITIES = new Set(['error', 'warn', 'info']);
const EFFECTS = new Set(['require-approval', 'deny', 'audit-only']);
const STATUSES = new Set(['draft', 'published', 'deprecated']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate one package.
 * @returns {{ ok: boolean, problems: Array<{path: string, code: string, message: string}> }}
 */
export function validateIr(ir) {
  const problems = [];
  const add = (path, code, message) => problems.push({ path, code, message });

  if (!isPlainObject(ir)) {
    return { ok: false, problems: [{ path: '$', code: 'not-object', message: '本体包必须是一个 JSON 对象' }] };
  }

  /* -------- package envelope -------- */
  if (typeof ir.irVersion !== 'string' || !IR_VERSION.test(ir.irVersion)) {
    add('$.irVersion', 'bad-version', 'irVersion 必须是 x.y.z');
  }
  if (typeof ir.id !== 'string' || !PACKAGE_ID.test(ir.id)) {
    add('$.id', 'bad-id', '资产包 id 必须是 域.名称 形式，例如 retail.store-inventory');
  }
  if (typeof ir.name !== 'string' || ir.name.trim() === '') add('$.name', 'missing', 'name 不能为空');
  if (typeof ir.version !== 'string' || !IR_VERSION.test(ir.version)) {
    add('$.version', 'bad-version', 'version 必须是 x.y.z');
  }
  if (ir.status !== undefined && !STATUSES.has(ir.status)) {
    add('$.status', 'bad-enum', 'status 只能是 draft | published | deprecated');
  }

  const objects = Array.isArray(ir.objects) ? ir.objects : [];
  if (objects.length === 0) add('$.objects', 'empty', '本体包至少需要一个对象');

  /* -------- objects -------- */
  const objectById = new Map();
  objects.forEach((obj, i) => {
    const at = `$.objects[${i}]`;
    if (!isPlainObject(obj)) return add(at, 'not-object', '对象必须是 JSON 对象');
    if (typeof obj.id !== 'string' || !OBJECT_ID.test(obj.id)) {
      add(`${at}.id`, 'bad-id', '对象 id 必须是 PascalCase，例如 Inventory');
    } else if (objectById.has(obj.id)) {
      add(`${at}.id`, 'duplicate', `对象 id 重复：${obj.id}`);
    } else {
      objectById.set(obj.id, obj);
    }
    if (typeof obj.name !== 'string' || obj.name.trim() === '') add(`${at}.name`, 'missing', '对象 name 不能为空');

    const props = Array.isArray(obj.properties) ? obj.properties : [];
    if (props.length === 0) add(`${at}.properties`, 'empty', `${obj.id || '对象'} 至少需要一个属性`);
    const propNames = new Set();
    props.forEach((p, j) => {
      const pat = `${at}.properties[${j}]`;
      if (!isPlainObject(p)) return add(pat, 'not-object', '属性必须是 JSON 对象');
      if (typeof p.name !== 'string' || !PROPERTY_NAME.test(p.name)) {
        add(`${pat}.name`, 'bad-id', '属性 name 必须是 camelCase');
      } else if (propNames.has(p.name)) {
        add(`${pat}.name`, 'duplicate', `属性名重复：${p.name}`);
      } else {
        propNames.add(p.name);
      }
      if (!PROPERTY_TYPES.has(p.type)) {
        add(`${pat}.type`, 'bad-enum', `属性类型不支持：${String(p.type)}`);
      }
      if (p.type === 'enum') {
        if (!Array.isArray(p.enum) || p.enum.length === 0) {
          add(`${pat}.enum`, 'missing', 'enum 属性必须声明 enum 取值');
        }
      } else if (p.enum !== undefined) {
        add(`${pat}.enum`, 'unexpected', '只有 enum 类型可以声明 enum 取值');
      }
      if (p.required !== undefined && typeof p.required !== 'boolean') {
        add(`${pat}.required`, 'bad-type', 'required 必须是布尔值');
      }
    });

    if (obj.keys !== undefined) {
      if (!Array.isArray(obj.keys) || obj.keys.length === 0) {
        add(`${at}.keys`, 'bad-type', 'keys 必须是非空数组');
      } else {
        for (const k of obj.keys) {
          if (!propNames.has(k)) {
            add(`${at}.keys`, 'dangling-key', `${obj.id || '对象'} 的主键属性不存在：${String(k)}`);
          }
        }
      }
    }
  });

  /* -------- links -------- */
  const links = Array.isArray(ir.links) ? ir.links : [];
  const linkIds = new Set();
  links.forEach((link, i) => {
    const at = `$.links[${i}]`;
    if (!isPlainObject(link)) return add(at, 'not-object', '关系必须是 JSON 对象');
    if (typeof link.id !== 'string' || !LINK_ID.test(link.id)) {
      add(`${at}.id`, 'bad-id', '关系 id 必须是 snake_case');
    } else if (linkIds.has(link.id)) {
      add(`${at}.id`, 'duplicate', `关系 id 重复：${link.id}`);
    } else {
      linkIds.add(link.id);
    }
    for (const side of ['source', 'target']) {
      if (typeof link[side] !== 'string' || !objectById.has(link[side])) {
        add(`${at}.${side}`, 'dangling-endpoint', `关系端点不存在：${String(link[side])}`);
      }
    }
    if (typeof link.type !== 'string' || link.type.trim() === '') {
      add(`${at}.type`, 'missing', '关系 type 不能为空');
    }
    if (link.cardinality !== undefined && !CARDINALITIES.has(link.cardinality)) {
      add(`${at}.cardinality`, 'bad-enum', 'cardinality 只能是 1:1 | 1:n | n:1 | n:m');
    }
  });

  /* -------- rules -------- */
  const rules = Array.isArray(ir.rules) ? ir.rules : [];
  const ruleIds = new Set();
  rules.forEach((rule, i) => {
    const at = `$.rules[${i}]`;
    if (!isPlainObject(rule)) return add(at, 'not-object', '规则必须是 JSON 对象');
    if (typeof rule.id !== 'string' || !QUALIFIED_ID.test(rule.id)) {
      add(`${at}.id`, 'bad-id', '规则 id 必须是 域.名称 形式');
    } else if (ruleIds.has(rule.id)) {
      add(`${at}.id`, 'duplicate', `规则 id 重复：${rule.id}`);
    } else {
      ruleIds.add(rule.id);
    }
    if (typeof rule.expression !== 'string' || rule.expression.trim() === '') {
      add(`${at}.expression`, 'missing', '规则表达式不能为空');
    }
    if (!SEVERITIES.has(rule.severity)) {
      add(`${at}.severity`, 'bad-enum', 'severity 只能是 error | warn | info');
    }
    if (rule.enabled !== undefined && typeof rule.enabled !== 'boolean') {
      add(`${at}.enabled`, 'bad-type', 'enabled 必须是布尔值');
    }
  });

  /* -------- actions -------- */
  const actions = Array.isArray(ir.actions) ? ir.actions : [];
  const actionIds = new Set();
  actions.forEach((action, i) => {
    const at = `$.actions[${i}]`;
    if (!isPlainObject(action)) return add(at, 'not-object', '动作必须是 JSON 对象');
    if (typeof action.id !== 'string' || !ACTION_ID.test(action.id)) {
      add(`${at}.id`, 'bad-id', '动作 id 必须是 camelCase');
    } else if (actionIds.has(action.id)) {
      add(`${at}.id`, 'duplicate', `动作 id 重复：${action.id}`);
    } else {
      actionIds.add(action.id);
    }
    if (typeof action.name !== 'string' || action.name.trim() === '') add(`${at}.name`, 'missing', '动作 name 不能为空');
    if (typeof action.approvalRequired !== 'boolean') {
      add(`${at}.approvalRequired`, 'bad-type', 'approvalRequired 必须显式声明布尔值');
    }
    if (action.writes !== undefined) {
      if (!Array.isArray(action.writes)) {
        add(`${at}.writes`, 'bad-type', 'writes 必须是数组');
      } else {
        for (const w of action.writes) {
          if (!objectById.has(w)) add(`${at}.writes`, 'dangling-write', `动作写入的对象不存在：${String(w)}`);
        }
      }
    }
  });

  /* -------- policies -------- */
  const policies = Array.isArray(ir.policies) ? ir.policies : [];
  const policyIds = new Set();
  policies.forEach((policy, i) => {
    const at = `$.policies[${i}]`;
    if (!isPlainObject(policy)) return add(at, 'not-object', '策略必须是 JSON 对象');
    if (typeof policy.id !== 'string' || !QUALIFIED_ID.test(policy.id)) {
      add(`${at}.id`, 'bad-id', '策略 id 必须是 域.名称 形式');
    } else if (policyIds.has(policy.id)) {
      add(`${at}.id`, 'duplicate', `策略 id 重复：${policy.id}`);
    } else {
      policyIds.add(policy.id);
    }
    if (!EFFECTS.has(policy.effect)) {
      add(`${at}.effect`, 'bad-enum', 'effect 只能是 require-approval | deny | audit-only');
    }
    if (policy.appliesTo !== undefined) {
      if (!Array.isArray(policy.appliesTo)) {
        add(`${at}.appliesTo`, 'bad-type', 'appliesTo 必须是数组');
      } else {
        for (const a of policy.appliesTo) {
          if (!actionIds.has(a)) add(`${at}.appliesTo`, 'dangling-target', `策略指向的动作不存在：${String(a)}`);
        }
      }
    }
  });

  return { ok: problems.length === 0, problems };
}

/** Counts used by tool output and the panel header. */
export function summarizeIr(ir) {
  return {
    id: ir.id,
    name: ir.name,
    version: ir.version,
    status: ir.status ?? 'draft',
    domain: ir.domain ?? null,
    owner: ir.owner ?? null,
    objects: (ir.objects || []).length,
    properties: (ir.objects || []).reduce((n, o) => n + (o.properties || []).length, 0),
    links: (ir.links || []).length,
    rules: (ir.rules || []).length,
    actions: (ir.actions || []).length,
    policies: (ir.policies || []).length,
  };
}

/**
 * Impact analysis for one object: what breaks if this object changes.
 * This is the server-side twin of the panel's 模型影响分析 card.
 */
export function impactOf(ir, objectId) {
  const obj = (ir.objects || []).find((o) => o.id === objectId);
  if (!obj) return null;

  const outgoing = (ir.links || []).filter((l) => l.source === objectId);
  const incoming = (ir.links || []).filter((l) => l.target === objectId);
  const actions = (ir.actions || []).filter((a) => (a.writes || []).includes(objectId));
  const actionIds = new Set(actions.map((a) => a.id));
  const policies = (ir.policies || []).filter((p) => (p.appliesTo || []).some((a) => actionIds.has(a)));

  const propNames = new Set((obj.properties || []).map((p) => p.name));
  const rules = (ir.rules || []).filter((r) => {
    const expr = String(r.expression || '');
    for (const name of propNames) {
      if (new RegExp(`\\b${name}\\b`).test(expr)) return true;
    }
    return false;
  });

  return {
    object: { id: obj.id, name: obj.name, properties: propNames.size },
    outgoingLinks: outgoing.map((l) => ({ id: l.id, target: l.target, type: l.type })),
    incomingLinks: incoming.map((l) => ({ id: l.id, source: l.source, type: l.type })),
    rules: rules.map((r) => ({ id: r.id, severity: r.severity, enabled: r.enabled !== false })),
    actions: actions.map((a) => ({ id: a.id, approvalRequired: a.approvalRequired })),
    policies: policies.map((p) => ({ id: p.id, effect: p.effect })),
    dependents: incoming.length + actions.length + rules.length,
  };
}

/** Reject a second package claiming an id or object namespace already taken. */
export function crossPackageProblems(packages) {
  const problems = [];
  const ids = new Map();
  for (const { file, ir } of packages) {
    if (ids.has(ir.id)) {
      problems.push({ path: file, code: 'duplicate-package', message: `资产包 id 已被 ${ids.get(ir.id)} 占用：${ir.id}` });
    } else {
      ids.set(ir.id, file);
    }
  }
  return problems;
}
