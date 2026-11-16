/**
 * 同步状态：一个 CSV 数据源被读进资产包之后，再读一次要能说清「变了什么」。
 *
 * 只回答三个问题，多一个都不答：
 *   什么时候读的（at）、这次读到多少行（rowCount）、和上次比变了什么（changes）。
 *
 * 刻意不做的：不做调度、不做增量拉取、不猜「哪一行是新增的」。
 * CSV 没有稳定主键顺序，行级 diff 会给出似是而非的结论；这里只比
 * 内容指纹（整体是否变化）、行数增减、列结构变化——这三件事的证据是硬的。
 *
 * 纯函数，不碰文件系统：读写两侧留给调用方，这样能单独测。
 */
import { createHash } from 'node:crypto';

/**
 * 内容指纹：表头 + 全部单元格，含每行长度，避免 ("a,b") 与 ("a","b") 撞车。
 * 与 store.etagOf 同一个形状（sha256- 前缀 + 16 位），便于并排显示。
 */
export function fingerprintOf(header, rows) {
  const hash = createHash('sha256');
  hash.update('h:' + header.join('\u0001'), 'utf8');
  for (const row of rows) {
    hash.update('\u0002' + row.length + ':' + row.join('\u0001'), 'utf8');
  }
  return 'sha256-' + hash.digest('hex').slice(0, 16);
}

/** 列结构变化：新增列 / 消失列 / 类型变了。按列名比对，不看位置。 */
export function diffColumns(previous, next) {
  const before = new Map((previous || []).map((c) => [c.name, c.type]));
  const after = new Map((next || []).map((c) => [c.name, c.type]));
  return {
    added: [...after.keys()].filter((n) => !before.has(n)),
    removed: [...before.keys()].filter((n) => !after.has(n)),
    typeChanged: [...after.entries()]
      .filter(([name, type]) => before.has(name) && before.get(name) !== type)
      .map(([name, to]) => ({ name, from: before.get(name), to })),
  };
}

/**
 * 生成一份新的同步状态。
 *
 * @param {{ packageId: string, path?: string, draft: object, previous?: object|null, now?: string }} input
 * @returns {{ ok: true, state: object }}
 */
export function nextSyncState(input) {
  const draft = input.draft;
  if (!draft || draft.ok === false || !Array.isArray(draft.columns)) {
    return { ok: false, problem: (draft && draft.problem) || '草稿无效，无法记录同步状态' };
  }
  const previous = input.previous || null;
  const at = input.now || new Date().toISOString();
  const columns = draft.columns.map((c) => ({
    name: c.name,
    property: c.property,
    type: c.type,
    fillRate: c.fillRate,
  }));
  const diff = diffColumns(previous && previous.columns, columns);
  const hash = draft.hash || null;
  const rowCount = draft.rowCount || 0;
  const first = !previous;

  // 指纹不同就是文件内容变了——哪怕行数一样、列还是一样。
  const dataChanged = first ? true : Boolean(hash && previous.hash && hash !== previous.hash);

  const state = {
    packageId: input.packageId,
    // 哪个对象吃这批列：补列时要落到它身上，不能靠「只有一个对象」去猜
    objectId: input.objectId || (previous && previous.objectId) || '',
    path: input.path || (previous && previous.path) || (draft.file ?? ''),
    at,
    rowCount,
    columnCount: columns.length,
    hash,
    columns,
    changes: {
      first,
      dataChanged,
      // 行数没有正负号陷阱：上次 0 行时增量就是这次的行数
      rowDelta: previous ? rowCount - previous.rowCount : rowCount,
      added: diff.added,
      removed: diff.removed,
      typeChanged: diff.typeChanged,
      schemaChanged: diff.added.length + diff.removed.length + diff.typeChanged.length > 0,
    },
    previous: previous
      ? { at: previous.at || null, hash: previous.hash || null, rowCount: previous.rowCount }
      : null,
    // 第几次读这个源：1 表示首次接入
    runs: ((previous && previous.runs) || 0) + 1,
  };
  return { ok: true, state };
}

/** `<x>.ir.json` ⇄ `<x>.sync.json`：同步状态是资产包的旁挂文件，不进 IR。 */
export function syncFileName(irFile) {
  return String(irFile).replace(/\.ir\.json$/, '.sync.json');
}

/** 一句话描述这份同步状态，人和 Agent 读同一句。 */
export function describeSync(state) {
  if (!state) return '尚未同步';
  const when = state.at ? String(state.at).replace('T', ' ').slice(0, 19) : '时间未知';
  if (!state.changes || state.changes.first) {
    return `首次接入于 ${when}：${state.rowCount} 行 × ${state.columnCount} 列`;
  }
  const bits = [];
  if (state.changes.rowDelta) bits.push(`行数 ${state.changes.rowDelta > 0 ? '+' : ''}${state.changes.rowDelta}`);
  if (state.changes.added.length) bits.push(`新增列 ${state.changes.added.join('、')}`);
  if (state.changes.removed.length) bits.push(`消失列 ${state.changes.removed.join('、')}`);
  if (state.changes.typeChanged.length) {
    bits.push(
      '类型变化 ' + state.changes.typeChanged.map((t) => `${t.name} ${t.from}→${t.to}`).join('、')
    );
  }
  if (!bits.length) bits.push(state.changes.dataChanged ? '内容有变化' : '无变化');
  return `上次同步 ${when}：${state.rowCount} 行，${bits.join('；')}`;
}
