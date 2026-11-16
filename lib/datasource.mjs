/**
 * 数据源接入的最小闭环：读一张 CSV → 推断列类型 → 生成本体对象草稿。
 *
 * 刻意做小：不做增量同步、不做多源、不做调度。
 * 目标是让 Data Studio 有一条能跑的真实路径，而不是只有示例文案。
 *
 * 安全边界：只读文件，不写；路径必须由调用方显式给出，不做目录扫描。
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fingerprintOf } from './sync.mjs';

/** 极简 CSV 解析：支持双引号包裹、引号内逗号、CRLF。不支持跨行字段。 */
export function parseCsv(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.length > 0);
  if (!lines.length) return { header: [], rows: [] };
  const split = (line) => {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else if (ch === '"') {
          quoted = false;
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === ',') {
        out.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out.map((v) => v.trim());
  };
  const header = split(lines[0]);
  const rows = lines.slice(1).map(split);
  return { header, rows };
}

/** 从值推断列类型，与本体 IR 的属性类型对齐。 */
export function inferType(values) {
  const present = values.filter((v) => v !== '' && v != null);
  if (!present.length) return 'string';
  const isInt = present.every((v) => /^-?\d+$/.test(v));
  if (isInt) return 'integer';
  const isNum = present.every((v) => /^-?\d+(\.\d+)?$/.test(v));
  if (isNum) return 'number';
  const isBool = present.every((v) => /^(true|false|0|1|是|否)$/i.test(v));
  if (isBool) return 'boolean';
  const isDate = present.every((v) => /^\d{4}-\d{2}-\d{2}$/.test(v));
  if (isDate) return 'date';
  const isDateTime = present.every((v) => /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(v));
  if (isDateTime) return 'datetime';
  return 'string';
}

const camel = (s) =>
  String(s)
    .replace(/[_\s]+/g, ' ')
    .replace(/[^\w\u4e00-\u9fa5 ]+/g, '')
    .trim()
    .split(/\s+/)
    .map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join('');

const pascal = (s) => {
  const c = camel(s);
  return c.charAt(0).toUpperCase() + c.slice(1);
};

/**
 * @param {{ path: string, objectId?: string, name?: string, keyColumns?: string[], sampleLimit?: number }} options
 */
export async function draftFromCsvFile(options) {
  const file = resolve(options.path);
  const text = await readFile(file, 'utf8');
  const { header, rows } = parseCsv(text);
  if (!header.length) {
    return { ok: false, problem: 'CSV 没有表头' };
  }
  const limit = Math.max(1, Math.min(200, options.sampleLimit || 50));
  const sample = rows.slice(0, limit);
  const columns = header.map((name, i) => {
    const values = sample.map((r) => r[i] ?? '');
    const filled = values.filter((v) => v !== '').length;
    return {
      name,
      property: camel(name),
      type: inferType(values),
      required: filled === values.length && values.length > 0,
      fillRate: values.length ? Math.round((filled / values.length) * 100) : 0,
    };
  });

  const base = String(options.path).split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  const id = options.objectId || pascal(base || 'Dataset');
  const keys = options.keyColumns && options.keyColumns.length
    ? options.keyColumns.map(camel)
    : [columns[0].property];

  return {
    ok: true,
    file,
    rowCount: rows.length,
    sampled: sample.length,
    // 内容指纹：同步状态靠它判断「文件到底变没变」，比行数可靠
    hash: fingerprintOf(header, rows),
    object: {
      id,
      name: options.name || id,
      description: '由 CSV 表头推断生成：' + file,
      keys,
      properties: columns.map((c) => ({
        name: c.property,
        label: c.name,
        type: c.type,
        required: c.required,
        storage: c.name,
      })),
    },
    columns,
    notes: [
      '类型由抽样值推断（' + sample.length + ' 行），空值不参与判断',
      '主键默认取第一列，可用 keyColumns 覆盖',
      '生成的是草稿：确认后再用 ontology_upsert_object 落盘',
    ],
  };
}

/**
 * 把 CSV 草稿包成一个完整的资产包 IR（纯函数，不写盘、不审批）。
 *
 * 拆出来是有意的：构建与落盘分开，落盘那一侧才需要过审批闸门。
 * 这样这个函数可以单独测，不需要文件系统。
 */
export function packageFromDraft(draft, options = {}) {
  if (!draft || !draft.ok || !draft.object) {
    return { ok: false, problem: (draft && draft.problem) || '草稿无效' };
  }
  const id = options.packageId || draft.object.id.toLowerCase();
  const ir = {
    irVersion: '1.0.0',
    id,
    name: options.name || draft.object.name || id,
    version: options.version || '0.1.0',
    status: 'draft',
    domain: options.domain || 'external',
    owner: options.owner || '',
    description: '由 CSV 生成：' + (draft.file || ''),
    objects: [draft.object],
    links: [],
    rules: [],
    actions: [],
  };
  return {
    ok: true,
    ir,
    source: {
      rowCount: draft.rowCount,
      sampled: draft.sampled,
      columns: draft.columns.length,
    },
    notes: [
      '生成的是 draft 状态的包，需要 ontology_publish 才会成为 published',
      '只包含一个对象；关系、规则、动作需要另行补充',
    ],
  };
}
