/**
 * Package diff: what changed between two versions of the same ontology.
 *
 * The registry can see an installed package and a newer catalog copy side by
 * side, but "should I upgrade?" needs an answer more precise than two version
 * numbers. Everything here is keyed by id, so the report names entities rather
 * than describing line noise.
 */

function byId(list) {
  const map = new Map();
  for (const item of list || []) if (item && typeof item.id === 'string') map.set(item.id, item);
  return map;
}

function diffCollection(name, before, after, compare) {
  const a = byId(before);
  const b = byId(after);
  const added = [...b.keys()].filter((id) => !a.has(id));
  const removed = [...a.keys()].filter((id) => !b.has(id));
  const changed = [];
  for (const id of [...a.keys()].filter((key) => b.has(key))) {
    const details = compare ? compare(a.get(id), b.get(id)) : [];
    if (details.length) changed.push({ id, changes: details });
  }
  return { collection: name, added, removed, changed };
}

/** Property-level changes for one object. */
function compareObject(before, after) {
  const changes = [];
  for (const field of ['name', 'description']) {
    if ((before[field] || '') !== (after[field] || '')) changes.push({ field, from: before[field] || '', to: after[field] || '' });
  }
  const keysBefore = (before.keys || []).join(',');
  const keysAfter = (after.keys || []).join(',');
  if (keysBefore !== keysAfter) changes.push({ field: 'keys', from: keysBefore, to: keysAfter });

  const propsA = byId((before.properties || []).map((p) => Object.assign({ id: p.name }, p)));
  const propsB = byId((after.properties || []).map((p) => Object.assign({ id: p.name }, p)));
  for (const name of propsB.keys()) {
    if (!propsA.has(name)) changes.push({ field: 'property', op: 'added', name });
  }
  for (const name of propsA.keys()) {
    if (!propsB.has(name)) changes.push({ field: 'property', op: 'removed', name });
  }
  for (const name of [...propsA.keys()].filter((n) => propsB.has(n))) {
    const a = propsA.get(name);
    const b = propsB.get(name);
    for (const field of ['type', 'label', 'required', 'enum']) {
      const av = JSON.stringify(a[field] === undefined ? null : a[field]);
      const bv = JSON.stringify(b[field] === undefined ? null : b[field]);
      if (av !== bv) changes.push({ field: 'property.' + field, name, from: av, to: bv });
    }
  }
  return changes;
}

function compareSimple(fields) {
  return (before, after) => {
    const changes = [];
    for (const field of fields) {
      const av = JSON.stringify(before[field] === undefined ? null : before[field]);
      const bv = JSON.stringify(after[field] === undefined ? null : after[field]);
      if (av !== bv) changes.push({ field, from: av, to: bv });
    }
    return changes;
  };
}

function compareAction(before, after) {
  const changes = compareSimple(['name', 'approvalRequired', 'writes', 'input'])(before, after);
  const execBefore = Boolean(before.effect && (before.inputSchema || []).length);
  const execAfter = Boolean(after.effect && (after.inputSchema || []).length);
  if (execBefore !== execAfter) changes.push({ field: 'executable', from: execBefore, to: execAfter });
  return changes;
}

/**
 * @param {object} before older package
 * @param {object} after newer package
 */
export function diffPackages(before, after) {
  const sections = [
    diffCollection('objects', before.objects, after.objects, compareObject),
    diffCollection('links', before.links, after.links, compareSimple(['source', 'target', 'type', 'cardinality'])),
    diffCollection('rules', before.rules, after.rules, compareSimple(['expression', 'severity', 'enabled', 'name'])),
    diffCollection('actions', before.actions, after.actions, compareAction),
    diffCollection('policies', before.policies, after.policies, compareSimple(['effect', 'appliesTo', 'name'])),
    diffCollection('agents', before.agents, after.agents, compareSimple(['status', 'model', 'usesObjects', 'tools', 'actions'])),
  ];

  const empty = sections.every((s) => !s.added.length && !s.removed.length && !s.changed.length);
  return {
    from: { id: before.id, version: before.version, status: before.status || 'draft' },
    to: { id: after.id, version: after.version, status: after.status || 'draft' },
    sameId: before.id === after.id,
    identical: empty,
    sections,
    summary: {
      added: sections.reduce((n, s) => n + s.added.length, 0),
      removed: sections.reduce((n, s) => n + s.removed.length, 0),
      changed: sections.reduce((n, s) => n + s.changed.length, 0),
    },
  };
}

/** One-line human summary, used by the tool renderer and the panel. */
export function describeDiff(diff) {
  if (diff.identical) return '两个版本完全一致';
  const parts = [];
  for (const section of diff.sections) {
    if (!section.added.length && !section.removed.length && !section.changed.length) continue;
    const bits = [];
    if (section.added.length) bits.push('+' + section.added.length);
    if (section.removed.length) bits.push('-' + section.removed.length);
    if (section.changed.length) bits.push('~' + section.changed.length);
    parts.push(section.collection + ' ' + bits.join('/'));
  }
  return parts.join('，');
}
