/**
 * Harness readiness check.
 *
 * The idea comes from Harness² (google-research): an agent is only as good as the
 * harness around it — prompt, guardrails, memory, tools, skills, delegation. We
 * cannot optimise that automatically, but we CAN say whether an ontology package
 * is ready to be an agent's substrate, and name the gaps.
 *
 * Every check is derived from the package itself. Nothing here needs a model, and
 * nothing here guesses: a gap is a fact about the files, not a score.
 */

const has = (value) => Array.isArray(value) && value.length > 0;

function degree(ir, objectId) {
  let count = 0;
  for (const link of ir.links || []) {
    if (link.source === objectId || link.target === objectId) count += 1;
  }
  return count;
}

/**
 * @param {object} ir validated package
 * @param {{ records?: object }} options optional fact data for the "has data" check
 */
export function harnessCheck(ir, options = {}) {
  const objects = ir.objects || [];
  const rules = ir.rules || [];
  const actions = ir.actions || [];
  const agents = ir.agents || [];
  const policies = ir.policies || [];
  const rowsByObject = (options.records && options.records.objects) || {};

  const gaps = [];
  const notes = [];
  const gap = (area, title, how) => gaps.push({ area, title, how });

  /* ---------------- structure ---------------- */
  const withoutKeys = objects.filter((o) => !has(o.keys));
  if (withoutKeys.length) {
    gap('结构', `${withoutKeys.length} 个对象没有主键：${withoutKeys.map((o) => o.id).join(', ')}`, '在对象编辑器里设置主键，否则无法定位一行');
  }

  const orphan = objects.filter((o) => degree(ir, o.id) === 0);
  if (orphan.length) {
    gap('结构', `${orphan.length} 个对象没有任何关系：${orphan.map((o) => o.id).join(', ')}`, '加关系才能在分析时跨对象关联——孤立对象只能单表查');
  }

  const empty = objects.filter((o) => !has(o.properties));
  if (empty.length) {
    gap('结构', `${empty.length} 个对象没有属性：${empty.map((o) => o.id).join(', ')}`, '没有属性就没有可描述的事实');
  }

  /* ---------------- rules ---------------- */
  if (rules.length === 0) {
    gap('规则', '一条规则都没有', '规则是「什么叫异常」的唯一可执行表达，没有它 Agent 只能描述不能判断');
  }
  const disabled = rules.filter((r) => r.enabled === false);
  if (disabled.length) {
    notes.push(`${disabled.length} 条规则处于停用状态：${disabled.map((r) => r.id).join(', ')}`);
  }

  /* ---------------- actions & guardrails ---------------- */
  const executable = actions.filter((a) => a.effect && Array.isArray(a.inputSchema) && a.inputSchema.length);
  if (actions.length === 0) {
    gap('动作', '没有声明任何动作', '没有动作，Agent 只能读不能改——业务闭环缺一半');
  } else if (executable.length === 0) {
    gap('动作', `${actions.length} 个动作都只有声明，没有一个可执行`, '补上 inputSchema 与 effect 才能真的落数据');
  } else if (executable.length < actions.length) {
    notes.push(`${actions.length} 个动作里只有 ${executable.length} 个可执行`);
  }

  const guarded = executable.filter((a) => a.approvalRequired === true);
  const unguarded = executable.filter((a) => a.approvalRequired !== true);
  if (executable.length && unguarded.length === executable.length) {
    gap('护栏', '所有可执行动作都不需要审批', '写数据的动作至少应有一个走审批——Agent 自主改业务数据需要人的关卡');
  }
  const coveredByPolicy = new Set();
  for (const policy of policies) {
    for (const id of policy.appliesTo || []) coveredByPolicy.add(id);
  }
  const needlessPolicy = actions.filter((a) => a.approvalRequired === true && !coveredByPolicy.has(a.id));
  if (needlessPolicy.length) {
    notes.push(`${needlessPolicy.length} 个需审批动作没有对应的策略声明：${needlessPolicy.map((a) => a.id).join(', ')}`);
  }

  /* ---------------- memory / data ---------------- */
  const withData = objects.filter((o) => Array.isArray(rowsByObject[o.id]) && rowsByObject[o.id].length > 0);
  if (options.records) {
    if (withData.length === 0) {
      gap('数据', '没有任何事实数据', '规则与动作都跑在事实数据上，没有数据就只能空转');
    } else if (withData.length < objects.length) {
      notes.push(`${objects.length} 个对象里只有 ${withData.length} 个有数据`);
    }
  }

  /* ---------------- agents ---------------- */
  if (agents.length === 0) {
    gap('Agent', '没有声明任何 Agent', '花名册是「谁在用这份本体」的唯一答案；没有它就不知道改动会影响谁');
  }
  for (const agent of agents) {
    if (!has(agent.usesObjects)) gap('Agent', `${agent.name} 没声明依赖哪些对象`, '声明后改动影响范围才算得出来');
    if (!has(agent.tools)) gap('Agent', `${agent.name} 没声明用哪些工具`, '不声明工具，轨迹就无法与预期对照');
    if (!agent.evalTarget) gap('Agent', `${agent.name} 没写评测口径`, '没有口径就无法判断它做得好不好');
  }

  /* ---------------- summary ---------------- */
  const areas = ['结构', '规则', '动作', '护栏', '数据', 'Agent'];
  const byArea = {};
  for (const area of areas) {
    byArea[area] = gaps.filter((g) => g.area === area).length;
  }
  const score = areas.filter((area) => byArea[area] === 0).length;

  return {
    packageId: ir.id,
    version: ir.version,
    gaps,
    notes,
    byArea,
    readyAreas: score,
    totalAreas: areas.length,
    verdict: gaps.length === 0 ? 'ready' : byArea['结构'] || byArea['动作'] ? 'incomplete' : 'workable',
  };
}
