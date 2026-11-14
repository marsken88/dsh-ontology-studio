/**
 * Export the ontology into artifacts other systems can consume.
 *
 * This is the "one IR, many downstream artifacts" claim made concrete: the same
 * property declarations produce a JSON Schema for record validation and a
 * Markdown reference for humans. Pure functions — nothing here writes files.
 */

/** Ontology property type → JSON Schema fragment. */
const JSON_SCHEMA_TYPES = {
  string: { type: 'string' },
  number: { type: 'number' },
  integer: { type: 'integer' },
  boolean: { type: 'boolean' },
  money: { type: 'number', description: '金额（decimal，建议以最小货币单位存储或用 decimal 类型）' },
  date: { type: 'string', format: 'date' },
  datetime: { type: 'string', format: 'date-time' },
  json: { type: 'object' },
};

/**
 * JSON Schema (draft 2020-12) for one object's records.
 * @param {object} ir package
 * @param {object} object object definition
 */
export function objectSchema(ir, object) {
  const properties = {};
  const required = [];
  for (const p of object.properties || []) {
    if (p.type === 'enum') {
      properties[p.name] = { type: 'string', enum: (p.enum || []).slice() };
    } else {
      properties[p.name] = Object.assign({}, JSON_SCHEMA_TYPES[p.type] || { type: 'string' });
    }
    if (p.label) properties[p.name].title = p.label;
    if (p.description) properties[p.name].description = p.description;
    if (p.required === true) required.push(p.name);
  }

  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${ir.id}/${object.id}`,
    title: object.name,
    type: 'object',
    properties,
    additionalProperties: false,
  };
  if (object.description) schema.description = object.description;
  if (required.length) schema.required = required;
  if (Array.isArray(object.keys) && object.keys.length) {
    schema['x-primary-key'] = object.keys.slice();
  }
  return schema;
}

/** Every object in the package, keyed by object id. */
export function packageSchemas(ir) {
  const schemas = {};
  for (const object of ir.objects || []) schemas[object.id] = objectSchema(ir, object);
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: ir.id,
    title: ir.name,
    version: ir.version,
    $defs: schemas,
  };
}

/** Human-readable reference: objects, links, rules, actions, policies. */
export function markdownDoc(ir) {
  const lines = [];
  lines.push(`# ${ir.name}（\`${ir.id}\`）`);
  lines.push('');
  lines.push(`- 版本：${ir.version}`);
  lines.push(`- 状态：${ir.status || 'draft'}`);
  if (ir.domain) lines.push(`- 业务域：${ir.domain}`);
  if (ir.owner) lines.push(`- 责任人：${ir.owner}`);
  if (ir.description) {
    lines.push('');
    lines.push(ir.description);
  }

  lines.push('');
  lines.push('## 对象');
  for (const object of ir.objects || []) {
    lines.push('');
    lines.push(`### ${object.name}（\`${object.id}\`）`);
    if (object.description) lines.push('');
    if (object.description) lines.push(object.description);
    lines.push('');
    lines.push('| 属性 | 名称 | 类型 | 必填 | 取值 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const p of object.properties || []) {
      lines.push(
        `| \`${p.name}\` | ${p.label || ''} | ${p.type} | ${p.required ? '是' : ''} | ${(p.enum || []).join(' / ')} |`
      );
    }
    if (Array.isArray(object.keys) && object.keys.length) {
      lines.push('');
      lines.push(`主键：\`${object.keys.join('`, `')}\``);
    }
  }

  if ((ir.links || []).length) {
    lines.push('');
    lines.push('## 关系');
    lines.push('');
    lines.push('| 关系 | 源 | 目标 | 类型 | 基数 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const l of ir.links) {
      lines.push(`| \`${l.id}\` | ${l.source} | ${l.target} | ${l.type} | ${l.cardinality || '—'} |`);
    }
  }

  if ((ir.rules || []).length) {
    lines.push('');
    lines.push('## 规则');
    lines.push('');
    lines.push('| 规则 | 名称 | 表达式 | 级别 | 状态 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const r of ir.rules) {
      lines.push(
        `| \`${r.id}\` | ${r.name} | \`${r.expression}\` | ${r.severity} | ${r.enabled === false ? '已停用' : '启用'} |`
      );
    }
  }

  if ((ir.actions || []).length) {
    lines.push('');
    lines.push('## 动作');
    lines.push('');
    lines.push('| 动作 | 名称 | 审批 | 写入 | 入参 | 可执行 |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const a of ir.actions) {
      const executable = Boolean(a.effect && Array.isArray(a.inputSchema) && a.inputSchema.length);
      const inputs = (a.inputSchema || []).map((f) => `${f.name}${f.required ? '' : '?'}`).join(', ') || '—';
      lines.push(
        `| \`${a.id}\` | ${a.name} | ${a.approvalRequired ? '需审批' : '免审批'} | ${(a.writes || []).join(', ') || '—'} | ${inputs} | ${executable ? '是' : '否'} |`
      );
    }
  }

  if ((ir.policies || []).length) {
    lines.push('');
    lines.push('## 策略');
    lines.push('');
    for (const p of ir.policies) {
      lines.push(`- \`${p.id}\` ${p.name}（${p.effect}）：作用于 ${(p.appliesTo || []).join(', ') || '—'}`);
    }
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('由 Ontology Studio 从统一 IR 生成。');
  return lines.join('\n');
}
