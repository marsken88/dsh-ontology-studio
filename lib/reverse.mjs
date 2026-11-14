/**
 * Reverse modeling: turn a physical table description into an ontology draft.
 *
 * The model does the *understanding* (what this table means, what it should be
 * called); this module does the *normalization* the platform must not leave to
 * chance: type mapping, naming conventions, key inference, relation hints, and a
 * validation pass over the resulting package.
 *
 * The draft is never written here. It is returned for review, so the human or
 * agent decides what enters the asset directory.
 */

/** SQL / warehouse types → ontology property types. */
const TYPE_MAP = [
  [/^(bool|boolean|tinyint\(1\)|bit)$/i, 'boolean'],
  [/^(smallint|int|integer|bigint|serial|bigserial)$/i, 'integer'],
  [/^(decimal|numeric|number|money|currency)/i, 'money'],
  [/^(float|double|real|numeric_double)/i, 'number'],
  [/^(timestamp|datetime|timestamptz)/i, 'datetime'],
  [/^(date)$/i, 'date'],
  [/^(json|jsonb|map|struct|array)/i, 'json'],
  [/^(varchar|char|nvarchar|text|string|uuid|enum)/i, 'string'],
];

/** Warehouse table prefixes that carry no meaning in the object name. */
const TABLE_PREFIXES = /^(dwd|dws|dim|ads|ods|dm|tmp|t)_+/i;

export function mapType(raw) {
  const value = String(raw || '').trim();
  const enumMatch = /^enum\((.*)\)$/i.exec(value);
  if (enumMatch) {
    const values = enumMatch[1]
      .split(',')
      .map((v) => v.trim().replace(/^['"]|['"]$/g, ''))
      .filter((v) => v !== '');
    return { type: 'enum', enum: values };
  }
  for (const [pattern, type] of TYPE_MAP) {
    if (pattern.test(value)) return { type };
  }
  return { type: 'string', unknownSourceType: value };
}

export function camelCase(name) {
  const parts = String(name)
    .trim()
    .replace(/[`"'[\]]/g, '')
    .split(/[_\-.\s]+/)
    .filter(Boolean);
  return parts
    .map((part, index) => {
      const lower = part.toLowerCase();
      // All-caps words (SKU, CODE) are acronyms: lowercase them, then capitalise
      // as a later segment. Mixed-case input keeps its own capitalisation.
      const isAcronym = part === part.toUpperCase() && /[A-Z]/.test(part);
      const base = isAcronym ? lower : part;
      if (index === 0) return base.charAt(0).toLowerCase() + base.slice(1);
      return base.charAt(0).toUpperCase() + base.slice(1);
    })
    .join('');
}

export function pascalCase(name) {
  const camel = camelCase(name);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

/** `InventorySnapshot` → `inventory_snapshot`, for snake_case identifiers. */
export function snakeCase(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s\-.]+/g, '_')
    .toLowerCase();
}

/** `dwd_inventory` → `Inventory`; `stores` → `Store` (naive but predictable). */
export function objectIdFromTable(tableName) {
  const stripped = String(tableName).replace(TABLE_PREFIXES, '');
  let id = pascalCase(stripped);
  if (id.length > 3 && /ies$/.test(id)) id = id.slice(0, -3) + 'y';
  else if (id.length > 3 && /[^s]s$/.test(id)) id = id.slice(0, -1);
  return id;
}

function humanName(table) {
  if (table.comment) return String(table.comment).replace(/表$/, '').trim();
  const words = String(table.name).replace(TABLE_PREFIXES, '').split(/[_\-\s]+/).filter(Boolean);
  return words.join(' ');
}

/**
 * @param {{ name: string, comment?: string, columns: Array<{ name: string, type: string, comment?: string, primaryKey?: boolean, nullable?: boolean }> }} table
 * @param {{ objects?: Array<{ id: string, name: string }> }} existing
 */
export function draftObjectFromTable(table, existing = {}) {
  const problems = [];
  if (!table || typeof table !== 'object') {
    return { object: null, links: [], problems: [{ code: 'bad-table', message: 'table 必须是一个对象' }] };
  }
  if (typeof table.name !== 'string' || table.name.trim() === '') {
    return { object: null, links: [], problems: [{ code: 'bad-table', message: 'table.name 不能为空' }] };
  }
  const columns = Array.isArray(table.columns) ? table.columns : [];
  if (columns.length === 0) {
    return { object: null, links: [], problems: [{ code: 'no-columns', message: `${table.name} 没有声明任何列` }] };
  }

  const objectId = objectIdFromTable(table.name);
  const properties = [];
  const seen = new Set();
  const keys = [];

  for (const column of columns) {
    if (!column || typeof column.name !== 'string' || column.name.trim() === '') {
      problems.push({ code: 'bad-column', message: '存在没有名字的列，已跳过' });
      continue;
    }
    const name = camelCase(column.name);
    if (seen.has(name)) {
      problems.push({ code: 'duplicate-column', message: `列名归一化后重复：${column.name} → ${name}` });
      continue;
    }
    seen.add(name);

    const mapped = mapType(column.type);
    if (mapped.unknownSourceType !== undefined) {
      problems.push({
        code: 'unknown-type',
        message: `${column.name} 的类型 ${column.type} 无法识别，已按 string 处理`,
      });
    }
    const property = { name, label: column.comment ? String(column.comment) : column.name, type: mapped.type };
    if (mapped.enum) property.enum = mapped.enum;
    if (column.nullable === false || column.primaryKey === true) property.required = true;
    properties.push(property);
    if (column.primaryKey === true) keys.push(name);
  }

  if (keys.length === 0) {
    const idColumn = properties.find((p) => p.name === 'id');
    if (idColumn) {
      keys.push('id');
      idColumn.required = true;
    } else {
      const firstKey = properties.find((p) => /Id$/.test(p.name));
      if (firstKey) keys.push(firstKey.name);
    }
  }
  if (keys.length === 0) {
    problems.push({ code: 'no-key', message: '没有识别出主键，请手工指定 keys 后再入库' });
  }

  const object = {
    id: objectId,
    name: humanName(table),
    description: table.comment ? String(table.comment) : `由 ${table.name} 反向生成，待业务确认。`,
    keys,
    properties,
  };

  // Relation hints: `<thing>Id` columns that name an existing object, either
  // exactly (`storeId` → Store) or as a qualifier (`fromStoreId` → Store).
  const known = [...new Set((existing.objects || []).map((o) => o.id))];
  const links = [];
  for (const property of properties) {
    if (keys.includes(property.name)) continue;
    const match = /^(.*)Id$/.exec(property.name);
    if (!match) continue;
    const stem = match[1].toLowerCase();
    const target = known.find((id) => {
      const lower = id.toLowerCase();
      return stem === lower || stem.endsWith(lower);
    });
    if (!target) continue;
    links.push({
      id: `${snakeCase(objectId)}_${snakeCase(match[1])}_references_${snakeCase(target)}`,
      source: objectId,
      target,
      type: 'references',
      cardinality: 'n:1',
    });
  }

  return { object, links, problems };
}

/**
 * Validate the draft inside a copy of the target package, so the caller learns
 * *before* writing whether the generated object is actually loadable.
 */
export function validateDraft(ir, draft) {
  if (!draft || !draft.object) return { ok: false, problems: [{ code: 'no-object', message: '没有生成对象' }] };
  const candidate = JSON.parse(JSON.stringify(ir));
  candidate.objects = (candidate.objects || []).filter((o) => o.id !== draft.object.id).concat([draft.object]);
  const knownLinks = new Set((candidate.links || []).map((l) => l.id));
  for (const link of draft.links || []) {
    if (!knownLinks.has(link.id)) (candidate.links || (candidate.links = [])).push(link);
  }
  return { candidate };
}
