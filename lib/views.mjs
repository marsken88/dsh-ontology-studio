/**
 * 视图（角色视角）：声明「某个角色能看见哪些对象的哪些属性」。
 *
 * 说清楚它是什么、不是什么：
 *   是——一份**可校验的声明**。属性名必须真的存在，否则整包校验不过；
 *       可以按视图裁剪 ontology_get 的返回、按视图导出 schema。
 *   不是——鉴权。没有身份主体时，「权限」只能裁剪输出，挡不住绕过：
 *       任何人调用时不传 view，看到的就还是全量。真正的读权限需要宿主
 *       层给出会话身份，那不在本插件的能力范围里。
 *
 * 所以这里刻意不做「拒绝」，只做「投影 + 把裁剪掉的东西说清楚」：
 * 看不见的对象、被裁掉的属性、以及规则表达式里仍然会碰到被裁属性的地方。
 */
import { resolveRule } from './rules.mjs';

/** 视图 id：kebab-case，和 agent id 同一套规则。 */
export const VIEW_ID = /^[a-z][a-z0-9-]*$/;

export function viewsOf(ir) {
  return Array.isArray(ir && ir.views) ? ir.views : [];
}

export function findView(ir, viewId) {
  return viewsOf(ir).find((v) => v.id === viewId) || null;
}

/**
 * 视图对一个对象的覆盖情况：写了哪些属性、对象一共有多少属性、漏了哪些。
 * @returns {{ objectId: string, total: number, covered: string[], uncovered: string[] }}
 */
export function viewCoverage(ir, view) {
  const objects = Array.isArray(ir.objects) ? ir.objects : [];
  return (view.objects || [])
    .map((entry) => {
      const obj = objects.find((o) => o.id === entry.objectId);
      if (!obj) return null;
      const declared = (obj.properties || []).map((p) => p.name);
      const covered = (entry.properties || []).filter((p) => declared.includes(p));
      return {
        objectId: obj.id,
        total: declared.length,
        covered,
        uncovered: declared.filter((p) => !covered.includes(p)),
      };
    })
    .filter(Boolean);
}

/** 一句话描述一个视图，面板和工具共用。 */
export function describeView(ir, view) {
  const coverage = viewCoverage(ir, view);
  const props = coverage.reduce((n, c) => n + c.covered.length, 0);
  const hidden = coverage.reduce((n, c) => n + c.uncovered.length, 0);
  const otherObjects = (ir.objects || []).length - coverage.length;
  const bits = [`${coverage.length} 个对象 / ${props} 个属性`];
  if (hidden) bits.push(`本视图内的对象还有 ${hidden} 个属性未暴露`);
  if (otherObjects > 0) bits.push(`另有 ${otherObjects} 个对象完全不可见`);
  return bits.join('，');
}

/**
 * 删掉一个对象之后清理视图。
 *
 * 不清理的话，级联删除会把包弄成不合法的：视图还引用着已经不存在的对象。
 * 这条路径上选择「跟着清理」而不是「拒绝删除」，因为级联删除的语义就是
 * 连带清理依赖；而改对象（upsert）时少了一个属性则保持「拒绝」——
 * 静默把属性从权限表里删掉比报错危险。
 *
 * @returns {string[]} 被改动或删除的视图 id
 */
export function trimViewsAfterObjectDelete(ir, objectId) {
  const views = Array.isArray(ir.views) ? ir.views : [];
  if (!views.length) return [];

  const remaining = new Map();
  for (const obj of ir.objects || []) {
    if (obj.id === objectId) continue;
    remaining.set(obj.id, new Set((obj.properties || []).map((p) => p.name)));
  }

  const touched = [];
  ir.views = views
    .map((view) => {
      const before = view.objects || [];
      const objects = before
        .filter((entry) => entry.objectId !== objectId)
        .map((entry) => {
          const allowed = remaining.get(entry.objectId);
          if (!allowed) return entry;
          const properties = (entry.properties || []).filter((p) => allowed.has(p));
          return properties.length === (entry.properties || []).length
            ? entry
            : Object.assign({}, entry, { properties });
        })
        .filter((entry) => (entry.properties || []).length > 0);
      if (objects.length !== before.length) touched.push(view.id);
      return Object.assign({}, view, { objects });
    })
    .filter((view) => (view.objects || []).length > 0);

  return touched;
}

/**
 * 按视图把资产包投影成一份更小的包。
 *
 * 规则的处理方式值得说明：不按「表达式里有没有被裁的属性」去删规则——
 * 那会让同一份规则在不同的视角下忽隐忽现，比留着更危险。这里保留规则，
 * 但把「表达式仍会碰到被裁属性」记进 leaks，让人能看见这个缺口。
 */
export function projectPackage(ir, viewId) {
  const view = findView(ir, viewId);
  if (!view) {
    return {
      ok: false,
      code: viewId ? 'view-not-found' : 'view-missing',
      message: viewId
        ? `视图不存在：${viewId}。已声明视图：${viewsOf(ir).map((v) => v.id).join('、') || '无'}`
        : '需要 view 参数：不传就是全量视图',
    };
  }

  const objects = Array.isArray(ir.objects) ? ir.objects : [];
  const allowed = new Map();
  for (const entry of view.objects || []) {
    allowed.set(entry.objectId, new Set(entry.properties || []));
  }

  const visible = objects.filter((o) => allowed.has(o.id));
  const hiddenObjects = objects.filter((o) => !allowed.has(o.id)).map((o) => o.id);

  const hiddenProperties = [];
  const projectedObjects = visible.map((o) => {
    const keep = allowed.get(o.id);
    const properties = (o.properties || []).filter((p) => keep.has(p.name));
    for (const p of o.properties || []) {
      if (!keep.has(p.name)) hiddenProperties.push({ objectId: o.id, name: p.name });
    }
    return Object.assign({}, o, { properties });
  });

  const visibleIds = new Set(projectedObjects.map((o) => o.id));
  const links = (ir.links || []).filter((l) => visibleIds.has(l.source) && visibleIds.has(l.target));

  // 规则：按归属对象是否可见来保留，然后单独报告表达式里的越界引用
  const seenProperties = new Set();
  for (const o of projectedObjects) for (const p of o.properties) seenProperties.add(p.name);
  const keptRules = [];
  const hiddenRules = [];
  const leaks = [];
  for (const rule of ir.rules || []) {
    const resolved = resolveRule(ir, rule);
    if (!resolved.objectId || !visibleIds.has(resolved.objectId)) {
      hiddenRules.push(rule.id);
      continue;
    }
    keptRules.push(rule);
    const outOfView = (resolved.identifiers || []).filter((name) => !seenProperties.has(name));
    if (outOfView.length) leaks.push({ ruleId: rule.id, identifiers: outOfView });
  }

  const keptActionIds = new Set();
  const hiddenActions = [];
  const visibleProps = new Map();
  for (const o of projectedObjects) visibleProps.set(o.id, new Set(o.properties.map((p) => p.name)));

  /**
   * 一个动作能不能留在视图里，不能只看它的对象可不可见：
   * effect 会碰具体属性（set / adjust / matchKeys），碰到被裁掉的属性，
   * 投影出来的包就是不合法的——与其把坏包交给 Agent，不如把动作挡在外面并说明原因。
   */
  const actionFitness = (action) => {
    const effects = Array.isArray(action.effect) ? action.effect : action.effect ? [action.effect] : [];
    if (!effects.length) return { ok: false, reason: '没有声明 effect，本来就不出动作' };
    for (const effect of effects) {
      const props = visibleProps.get(effect.object);
      if (!props) return { ok: false, reason: `写入的对象不可见：${effect.object}` };
      const touched = [
        ...Object.keys(effect.set || {}),
        ...Object.keys(effect.adjust || {}),
        ...(effect.matchKeys || []).map((k) => (typeof k === 'string' ? k : k && k.field)),
      ].filter(Boolean);
      const missing = touched.filter((field) => !props.has(field));
      if (missing.length) {
        return { ok: false, reason: `${effect.object} 的这些属性在视图里不可见：${missing.join('、')}` };
      }
    }
    for (const w of action.writes || []) {
      if (!visibleIds.has(w)) return { ok: false, reason: `写入的对象不可见：${w}` };
    }
    return { ok: true };
  };

  for (const action of ir.actions || []) {
    const fit = actionFitness(action);
    if (fit.ok) keptActionIds.add(action.id);
    else hiddenActions.push({ id: action.id, reason: fit.reason });
  }
  const actions = (ir.actions || []).filter((a) => keptActionIds.has(a.id));
  const policies = (ir.policies || []).filter((p) =>
    (p.appliesTo || []).every((id) => keptActionIds.has(id))
  );

  const keptAgents = [];
  const hiddenAgents = [];
  for (const agent of ir.agents || []) {
    const uses = agent.usesObjects || [];
    if (uses.every((o) => visibleIds.has(o))) keptAgents.push(agent);
    else hiddenAgents.push(agent.id);
  }

  const projected = {
    irVersion: ir.irVersion,
    id: ir.id,
    name: ir.name,
    version: ir.version,
    status: ir.status,
    domain: ir.domain,
    owner: ir.owner,
    description: ir.description,
    objects: projectedObjects,
    links,
    rules: keptRules,
    actions,
    policies,
    agents: keptAgents,
    dependsOn: ir.dependsOn,
  };
  // 视图里不再带视图：视图的视图没有意义，只会让人以为能层层收窄
  for (const key of Object.keys(projected)) {
    if (projected[key] === undefined) delete projected[key];
  }

  return {
    ok: true,
    view: { id: view.id, name: view.name, description: view.description || '' },
    ir: projected,
    coverage: viewCoverage(ir, view),
    hidden: {
      objects: hiddenObjects,
      properties: hiddenProperties,
      links: (ir.links || []).length - links.length,
      rules: hiddenRules,
      actions: hiddenActions,
      agents: hiddenAgents,
    },
    leaks,
    notes: [
      '这是输出裁剪，不是鉴权：不传 view 的调用看到的仍是全量',
      '规则保留但表达式可能仍引用被裁掉的属性，见 leaks',
    ],
  };
}
