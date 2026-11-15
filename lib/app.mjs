/**
 * App generation: turn object metadata into a page spec.
 *
 * This is the deterministic half of App Studio. The IR already says what an
 * object has, what can be filtered and what actions exist — so the list columns,
 * filters and action forms can be derived instead of hand-built. A renderer (the
 * panel, or a future code generator) consumes the spec; nothing here knows about
 * HTML or React.
 */

const NUMERIC = new Set(['number', 'integer', 'money']);

function columnOf(property) {
  return {
    field: property.name,
    label: property.label || property.name,
    type: property.type,
    align: NUMERIC.has(property.type) ? 'right' : 'left',
    display: property.type === 'enum' ? 'badge' : property.type === 'money' ? 'amount' : 'text',
    sortable: true,
  };
}

function filterOf(property) {
  if (property.type === 'enum') return { field: property.name, label: property.label || property.name, kind: 'select', options: (property.enum || []).slice() };
  if (property.type === 'date' || property.type === 'datetime') {
    return { field: property.name, label: property.label || property.name, kind: 'dateRange' };
  }
  return null;
}

/** Action forms come straight from the action's inputSchema. */
function actionOf(action) {
  const executable = Boolean(action.effect && Array.isArray(action.inputSchema) && action.inputSchema.length);
  if (!executable) return null;
  return {
    actionId: action.id,
    label: action.name,
    approvalRequired: action.approvalRequired === true,
    effectCount: Array.isArray(action.effect) ? action.effect.length : 1,
    form: (action.inputSchema || []).map((field) => ({
      field: field.name,
      label: field.label || field.name,
      type: field.type,
      required: field.required === true,
      options: field.type === 'enum' ? (field.enum || []).slice() : undefined,
    })),
  };
}

/**
 * @param {object} ir validated package
 * @param {{ objects?: string[] }} options which objects to build pages for (default: all)
 */
export function generateAppSpec(ir, options = {}) {
  const wanted = Array.isArray(options.objects) && options.objects.length ? options.objects : null;
  const objects = (ir.objects || []).filter((o) => !wanted || wanted.includes(o.id));
  const actions = ir.actions || [];
  const notes = [];

  if (wanted) {
    const missing = wanted.filter((id) => !(ir.objects || []).some((o) => o.id === id));
    if (missing.length) notes.push(`请求的对象不存在，已跳过：${missing.join(', ')}`);
  }

  const pages = objects.map((object) => {
    const properties = object.properties || [];
    const pageActions = actions
      .filter((a) => (a.writes || []).includes(object.id))
      .map(actionOf)
      .filter(Boolean);

    const declaredActions = actions.filter((a) => (a.writes || []).includes(object.id)).length;
    if (declaredActions > pageActions.length) {
      notes.push(`${object.id} 有 ${declaredActions - pageActions.length} 个动作只有声明，没有生成表单`);
    }

    const filters = properties.map(filterOf).filter(Boolean);
    if (filters.length === 0) notes.push(`${object.id} 没有可枚举/可日期过滤的属性，列表页不带筛选器`);

    return {
      id: `${object.id}.list`,
      kind: 'list',
      title: object.name,
      source: object.id,
      keyFields: (object.keys || []).slice(),
      columns: properties.filter((p) => p.type !== 'json').map(columnOf),
      filters,
      detailFields: properties.map((p) => ({
        field: p.name,
        label: p.label || p.name,
        type: p.type,
        required: p.required === true,
      })),
      actions: pageActions,
    };
  });

  return {
    appId: `${ir.id}.app`,
    title: ir.name,
    generatedFrom: { packageId: ir.id, version: ir.version },
    objectCount: objects.length,
    pageCount: pages.length,
    pages,
    notes,
  };
}
