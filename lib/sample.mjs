/**
 * Reverse modeling from a sample payload.
 *
 * Table DDL is only one input shape; APIs hand you a JSON example instead. The
 * same normalization applies — infer types from values, snake→camel the keys,
 * guess a primary key, and suggest relations from nested objects or `*Id` fields.
 * Deterministic: the same payload always produces the same draft.
 */

const CAMEL_OK = /^[a-z][A-Za-z0-9]*$/;

export function camelCase(name) {
  const parts = String(name)
    .trim()
    .replace(/[`"'[\]]/g, '')
    .split(/[_\-.\s]+/)
    .filter(Boolean);
  return parts
    .map((part, index) => {
      const lower = part.toLowerCase();
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

export function snakeCase(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s\-.]+/g, '_')
    .toLowerCase();
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/** Infer one property from a sample value. */
export function inferProperty(key, value) {
  const name = camelCase(key);
  const base = { name, label: key };
  if (value === null || value === undefined) {
    return Object.assign(base, { type: 'string', note: '样例里是空值，类型无从推断，暂按 string' });
  }
  if (typeof value === 'number') {
    return Object.assign(base, { type: Number.isInteger(value) ? 'integer' : 'number' });
  }
  if (typeof value === 'boolean') return Object.assign(base, { type: 'boolean' });
  if (Array.isArray(value)) return Object.assign(base, { type: 'json', note: '数组，暂按 json' });
  if (typeof value === 'object') return Object.assign(base, { type: 'json', note: '嵌套对象，已单独抽成对象' });
  const text = String(value);
  if (ISO_DATE.test(text)) return Object.assign(base, { type: 'date' });
  if (ISO_DATETIME.test(text)) return Object.assign(base, { type: 'datetime' });
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    return Object.assign(base, { type: text.includes('.') ? 'number' : 'integer', note: '样例是字符串形式的数字' });
  }
  if (/^[A-Z]{2,}$/.test(text)) return Object.assign(base, { type: 'enum', note: '样例是大写枚举，取值待补' });
  return Object.assign(base, { type: 'string' });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {object} payload one representative JSON object (array → its first element)
 * @param {{ objects?: Array<{id: string, name: string}> , objectId?: string }} options
 */
export function draftFromSample(payload, options = {}) {
  const problems = [];
  let sample = payload;
  if (Array.isArray(sample)) {
    if (sample.length === 0) {
      return { object: null, links: [], nested: [], problems: [{ code: 'empty-array', message: '样例是空数组，无法推断字段' }] };
    }
    sample = sample[0];
    problems.push({ code: 'array-sample', message: '样例是数组，已按第一条推断字段' });
  }
  if (!isPlainObject(sample)) {
    return { object: null, links: [], nested: [], problems: [{ code: 'bad-sample', message: '样例必须是 JSON 对象或对象数组' }] };
  }

  const objectId = options.objectId ? pascalCase(options.objectId) : 'SampleObject';
  const properties = [];
  const nested = [];

  for (const [key, value] of Object.entries(sample)) {
    if (isPlainObject(value)) {
      // A nested object is most likely its own entity; keep a reference by name.
      const child = draftFromSample(value, { objectId: key });
      if (child.object) {
        nested.push(child.object);
        properties.push({ name: camelCase(key), label: key, type: 'json', note: '嵌套对象，见同名字段建议' });
        problems.push({ code: 'nested-object', message: `${key} 是嵌套对象，已抽成独立对象，关系需人工确认` });
        continue;
      }
    }
    const property = inferProperty(key, value);
    if (property.note) problems.push({ code: 'inferred', message: `${key}：${property.note}` });
    const clean = { name: property.name, label: property.label, type: property.type };
    if (!CAMEL_OK.test(clean.name)) {
      problems.push({ code: 'bad-name', message: `${key} 归一化后不是合法 camelCase：${clean.name}` });
      continue;
    }
    properties.push(clean);
  }

  // Primary key, most specific first: `id`, then `<Object>Id`, then a
  // `<something>No`/`Code`, then any `*Id`. Picking the first `*Id` blindly
  // would elect a foreign key and then hide the very relation it implies.
  const keys = [];
  const selfId = objectId.charAt(0).toLowerCase() + objectId.slice(1) + 'Id';
  const candidates = [
    (p) => p.name === 'id',
    (p) => p.name === selfId,
    (p) => /(No|Code)$/.test(p.name),
    (p) => /Id$/.test(p.name),
  ];
  for (const test of candidates) {
    const hit = properties.find(test);
    if (hit) {
      keys.push(hit.name);
      break;
    }
  }
  if (keys.length === 0) problems.push({ code: 'no-key', message: '没有识别出主键（既无 id 也无 *Id 字段）' });

  const object = { id: objectId, name: options.name || objectId, keys, properties };

  // Relations: `*Id` fields naming an existing object, plus nested-object guesses.
  const known = [...new Set((options.objects || []).map((o) => o.id))];
  const links = [];
  for (const property of properties) {
    const match = /^(.*)Id$/.exec(property.name);
    if (!match || keys.includes(property.name)) continue;
    const stem = match[1].toLowerCase();
    const target = known.find((id) => {
      const lower = id.toLowerCase();
      return stem === lower || stem.endsWith(lower);
    });
    if (!target) continue;
    const stemSegment = snakeCase(match[1]);
    const targetSegment = snakeCase(target);
    const middle = stemSegment === targetSegment ? '' : stemSegment + '_';
    links.push({
      id: `${snakeCase(objectId)}_${middle}references_${targetSegment}`,
      source: objectId,
      target,
      type: 'references',
      cardinality: 'n:1',
    });
  }

  return { object, links, nested, problems };
}
