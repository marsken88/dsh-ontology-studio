/**
 * Ontology IR — pure validation and analysis helpers.
 *
 * `assets/ontology-ir.schema.json` describes the shape; the checks here cover
 * what a JSON Schema cannot express: cross references between entities
 * (link endpoints, key properties, action writes, policy targets) and
 * registry-wide uniqueness across packages.
 *
 * No I/O — callers pass parsed objects in.
 */
import { parse as parseExpression, identifiersOf as identifiersOfExpression } from './expr.mjs';

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
/** Rule expressions longer than this are almost certainly generated noise. */
export const MAX_EXPRESSION = 4000;
const AGENT_ID = /^[a-z][a-z0-9-]*$/;
const AGENT_STATUSES = new Set(['published', 'gray', 'draft', 'retired']);

/**
 * Keys each node may carry. The published JSON Schema declares
 * `additionalProperties: false` everywhere, so the code validator must enforce
 * the same thing — otherwise a typo like `aprovalRequired` silently drops a
 * field instead of being reported.
 */
const ALLOWED = {
  package: new Set([
    'irVersion', 'id', 'name', 'description', 'domain', 'version', 'owner', 'status',
    'objects', 'links', 'rules', 'actions', 'policies', 'extensions', 'dependsOn', 'agents',
  ]),
  object: new Set(['id', 'name', 'description', 'keys', 'properties']),
  property: new Set(['name', 'label', 'type', 'required', 'enum', 'description', 'storage', 'indexed']),
  link: new Set(['id', 'source', 'target', 'type', 'cardinality']),
  rule: new Set(['id', 'name', 'expression', 'severity', 'enabled', 'owner']),
  action: new Set(['id', 'name', 'input', 'inputSchema', 'approvalRequired', 'writes', 'effect']),
  policy: new Set(['id', 'name', 'appliesTo', 'effect']),
  agent: new Set(['id', 'name', 'model', 'status', 'usesObjects', 'skills', 'tools', 'actions', 'evalTarget', 'owner']),
  effect: new Set(['object', 'matchKeys', 'set', 'adjust']),
};

function checkKeys(node, kind, at, add) {
  const allowed = ALLOWED[kind];
  if (!allowed || !isPlainObject(node)) return;
  for (const key of Object.keys(node)) {
    if (!allowed.has(key)) {
      add(`${at}.${key}`, 'unknown-key', `未知字段 ${key}（${kind} 不接受该字段，检查是否拼写错误）`);
    }
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Shared property-list validation (objects and action input schemas).
 * @returns {Set<string>} declared names, for cross-reference checks
 */
function checkProperties(props, at, add) {
  const names = new Set();
  if (!Array.isArray(props)) {
    add(at, 'bad-type', '属性列表必须是数组');
    return names;
  }
  props.forEach((p, j) => {
    const pat = `${at}[${j}]`;
    if (!isPlainObject(p)) return add(pat, 'not-object', '属性必须是 JSON 对象');
    checkKeys(p, 'property', pat, add);
    if (typeof p.name !== 'string' || !PROPERTY_NAME.test(p.name)) {
      add(`${pat}.name`, 'bad-id', '属性 name 必须是 camelCase');
    } else if (names.has(p.name)) {
      add(`${pat}.name`, 'duplicate', `属性名重复：${p.name}`);
    } else {
      names.add(p.name);
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
  return names;
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
  checkKeys(ir, 'package', '$', add);

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

  /* -------- dependencies (shape only; installation order is the registry's job) -------- */
  if (ir.dependsOn !== undefined) {
    if (!Array.isArray(ir.dependsOn)) {
      add('$.dependsOn', 'bad-type', 'dependsOn 必须是数组');
    } else {
      for (const dep of ir.dependsOn) {
        if (typeof dep !== 'string' || dep.trim() === '') {
          add('$.dependsOn', 'bad-type', 'dependsOn 只能包含非空字符串');
        } else if (dep === ir.id) {
          add('$.dependsOn', 'self-dependency', '资产包不能依赖自己');
        }
      }
    }
  }

  const objects = Array.isArray(ir.objects) ? ir.objects : [];
  if (objects.length === 0) add('$.objects', 'empty', '本体包至少需要一个对象');

  /* -------- objects -------- */
  const objectById = new Map();
  objects.forEach((obj, i) => {
    const at = `$.objects[${i}]`;
    if (!isPlainObject(obj)) return add(at, 'not-object', '对象必须是 JSON 对象');
    checkKeys(obj, 'object', at, add);
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
    const propNames = checkProperties(props, `${at}.properties`, add);

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
    checkKeys(link, 'link', at, add);
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
    checkKeys(rule, 'rule', at, add);
    if (typeof rule.id !== 'string' || !QUALIFIED_ID.test(rule.id)) {
      add(`${at}.id`, 'bad-id', '规则 id 必须是 域.名称 形式，名称部分用 camelCase，例如 inventory.lowStockWarning');
    } else if (ruleIds.has(rule.id)) {
      add(`${at}.id`, 'duplicate', `规则 id 重复：${rule.id}`);
    } else {
      ruleIds.add(rule.id);
    }
    if (typeof rule.expression !== 'string' || rule.expression.trim() === '') {
      add(`${at}.expression`, 'missing', '规则表达式不能为空');
    } else if (rule.expression.length > MAX_EXPRESSION) {
      // A megabyte-long expression costs ~100ms to parse on every validate and
      // every evaluation pass. Real rules are well under 200 characters.
      add(`${at}.expression`, 'too-long', `表达式过长（${rule.expression.length} 字符，上限 ${MAX_EXPRESSION}）`);
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
    checkKeys(action, 'action', at, add);
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

    const inputFields =
      action.inputSchema === undefined ? null : checkProperties(action.inputSchema, `${at}.inputSchema`, add);

    if (action.effect !== undefined) {
      const eat = `${at}.effect`;
      const list = Array.isArray(action.effect) ? action.effect : [action.effect];
      if (Array.isArray(action.effect) && list.length === 0) {
        add(eat, 'empty', 'effect 数组不能为空');
      }
      if (action.inputSchema === undefined) {
        add(eat, 'effect-without-input', '声明了 effect 的动作必须同时声明 inputSchema');
      }

      list.forEach((effect, k) => {
        const eAt = Array.isArray(action.effect) ? `${eat}[${k}]` : eat;
        if (!isPlainObject(effect)) {
          add(eAt, 'not-object', 'effect 必须是 JSON 对象');
          return;
        }
        checkKeys(effect, 'effect', eAt, add);

        const target = objectById.get(effect.object);
        if (!target) {
          add(`${eAt}.object`, 'dangling-effect-object', `effect 指向的对象不存在：${String(effect.object)}`);
        }
        if (!Array.isArray(effect.matchKeys) || effect.matchKeys.length === 0) {
          add(`${eAt}.matchKeys`, 'bad-type', 'matchKeys 必须是非空数组');
        }

        const hasSet = isPlainObject(effect.set) && Object.keys(effect.set).length > 0;
        const hasAdjust = isPlainObject(effect.adjust) && Object.keys(effect.adjust).length > 0;
        if (!hasSet && !hasAdjust) {
          add(eAt, 'no-operation', 'effect 至少要声明 set 或 adjust 之一');
        }
        if (effect.set !== undefined && !isPlainObject(effect.set)) {
          add(`${eAt}.set`, 'bad-type', 'set 必须是对象');
        }
        if (effect.adjust !== undefined && !isPlainObject(effect.adjust)) {
          add(`${eAt}.adjust`, 'bad-type', 'adjust 必须是对象');
        }

        if (!target) return;
        const targetProps = new Map((target.properties || []).map((p) => [p.name, p]));

        for (const key of Array.isArray(effect.matchKeys) ? effect.matchKeys : []) {
          const field = typeof key === 'string' ? key : key && key.field;
          const from = typeof key === 'string' ? key : key && key.from;
          if (typeof field !== 'string' || !targetProps.has(field)) {
            add(`${eAt}.matchKeys`, 'dangling-match-key', `${effect.object} 没有属性：${String(field)}`);
          }
          if (typeof from !== 'string' || (inputFields && !inputFields.has(from))) {
            add(`${eAt}.matchKeys`, 'unknown-input-field', `入参里没有字段：${String(from)}`);
          }
        }

        for (const [field, source] of Object.entries(hasSet ? effect.set : {})) {
          if (!targetProps.has(field)) {
            add(`${eAt}.set`, 'dangling-set-field', `${effect.object} 没有属性：${field}`);
          }
          if (inputFields && !inputFields.has(source)) {
            add(`${eAt}.set`, 'unknown-input-field', `入参里没有字段：${String(source)}`);
          }
        }

        for (const [field, expression] of Object.entries(hasAdjust ? effect.adjust : {})) {
          const property = targetProps.get(field);
          if (!property) {
            add(`${eAt}.adjust`, 'dangling-adjust-field', `${effect.object} 没有属性：${field}`);
            continue;
          }
          if (!['number', 'integer', 'money'].includes(property.type)) {
            add(`${eAt}.adjust`, 'non-numeric-adjust', `${field} 的类型是 ${property.type}，不能做增量调整`);
          }
          if (typeof expression !== 'string') {
            add(`${eAt}.adjust`, 'bad-type', `${field} 的增量必须是表达式字符串`);
            continue;
          }
          try {
            const ast = parseExpression(expression);
            for (const name of identifiersOfExpression(ast)) {
              if (inputFields && !inputFields.has(name)) {
                add(`${eAt}.adjust`, 'unknown-input-field', `增量表达式的入参里没有字段：${name}`);
              }
            }
          } catch (error) {
            add(`${eAt}.adjust`, 'bad-expression', `${field} 的增量表达式无法解析：${error.message}`);
          }
        }
      });
    }
  });

  /* -------- policies -------- */
  const policies = Array.isArray(ir.policies) ? ir.policies : [];
  const policyIds = new Set();
  policies.forEach((policy, i) => {
    const at = `$.policies[${i}]`;
    if (!isPlainObject(policy)) return add(at, 'not-object', '策略必须是 JSON 对象');
    checkKeys(policy, 'policy', at, add);
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

  /* -------- agents (declarative roster; runtime data lives in the trace) -------- */
  const agents = Array.isArray(ir.agents) ? ir.agents : [];
  const agentIds = new Set();
  agents.forEach((agent, i) => {
    const at = `$.agents[${i}]`;
    if (!isPlainObject(agent)) {
      add(at, 'not-object', 'agent 必须是 JSON 对象');
      return;
    }
    checkKeys(agent, 'agent', at, add);
    if (typeof agent.id !== 'string' || !AGENT_ID.test(agent.id)) {
      add(`${at}.id`, 'bad-id', 'agent id 必须是 kebab-case，例如 stock-replenisher');
    } else if (agentIds.has(agent.id)) {
      add(`${at}.id`, 'duplicate', `agent id 重复：${agent.id}`);
    } else {
      agentIds.add(agent.id);
    }
    if (typeof agent.name !== 'string' || agent.name.trim() === '') add(`${at}.name`, 'missing', 'agent name 不能为空');
    if (agent.status !== undefined && !AGENT_STATUSES.has(agent.status)) {
      add(`${at}.status`, 'bad-enum', 'status 只能是 published | gray | draft | retired');
    }
    for (const objectId of agent.usesObjects || []) {
      if (!objectById.has(objectId)) {
        add(`${at}.usesObjects`, 'dangling-object', `agent 引用的对象不存在：${String(objectId)}`);
      }
    }
    for (const actionId of agent.actions || []) {
      if (!actionIds.has(actionId)) {
        add(`${at}.actions`, 'dangling-action', `agent 引用的动作不存在：${String(actionId)}`);
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
