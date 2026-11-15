/**
 * Ontology context brief for the model.
 *
 * The point of a Context Engine is that the agent should not have to spend a
 * tool round-trip discovering what the ontology contains. This builds a compact,
 * *stable* brief — same ontology in, byte-identical text out — so it does not
 * churn the prompt cache between steps.
 *
 * It is deliberately bounded: objects list their key fields only, and the whole
 * brief is capped, degrading object detail before dropping structure.
 */
const DEFAULT_MAX_CHARS = 4000;

function propertyList(obj, limit = 8) {
  const names = (obj.properties || []).map((p) => p.name);
  if (names.length <= limit) return names.join(', ');
  return names.slice(0, limit).join(', ') + ` …共 ${names.length} 个`;
}

function actionLine(action) {
  const approval = action.approvalRequired ? '需审批' : '免审批';
  const writes = (action.writes || []).join(', ') || '—';
  const inputs = (action.inputSchema || []).map((f) => f.name + (f.required ? '' : '?')).join(', ');
  return `- ${action.id} ${action.name}（${approval}）→ 写 ${writes}；入参 ${inputs}`;
}

/**
 * @param {object} ir validated IR package
 * @param {{ maxChars?: number, level?: 'brief'|'full' }} options
 * @returns {string}
 */
export function buildBrief(ir, options = {}) {
  if (!ir || !Array.isArray(ir.objects)) return '';
  const maxChars = Number.isFinite(options.maxChars) ? Math.max(400, options.maxChars) : DEFAULT_MAX_CHARS;
  const level = options.level === 'full' ? 'full' : 'brief';

  const runnable = (ir.actions || []).filter((a) => a.effect && Array.isArray(a.inputSchema) && a.inputSchema.length);
  const notRunnable = (ir.actions || []).filter((a) => !(a.effect && Array.isArray(a.inputSchema) && a.inputSchema.length));
  const rules = ir.rules || [];

  const render = (detail) =>
    [
      `## 本体上下文 · ${ir.name || ir.id}`,
      `资产包 \`${ir.id}\` v${ir.version}（${ir.status || 'draft'}，域 ${ir.domain || '—'}，责任人 ${ir.owner || '—'}）`,
      '',
      '### 对象',
      ...(ir.objects || []).map((obj) => {
        const keys = (obj.keys || []).join('+') || '—';
        const head = `- **${obj.id}** ${obj.name}（${(obj.properties || []).length} 属性，主键 ${keys}）：`;
        if (!detail) return head.slice(0, -1);
        return head + propertyList(obj);
      }),
      '',
      `### 规则（${rules.length} 条）`,
      ...(rules.length
        ? rules.map((r) => `- ${r.id} [${r.severity}${r.enabled === false ? '，已停用' : ''}] \`${r.expression}\``)
        : ['- 无']),
      '',
      '### 可执行动作',
      ...(runnable.length ? runnable.map(actionLine) : ['- 无（动作都缺 inputSchema 或 effect）']),
      ...(notRunnable.length
        ? ['', '### 暂不可执行的动作', notRunnable.map((a) => `- ${a.id} ${a.name}（缺 inputSchema 或 effect）`).join('\n')]
        : []),
      '',
      '### 工具用法',
      '- 结构：`ontology_get`（带 objectId 取对象详情）；全量清单 `ontology_list`',
      '- 修改资产：`ontology_upsert_object` / `ontology_upsert_link` / `ontology_delete_*`，改完必须 `ontology_validate`',
      '- 改动前评估：`ontology_impact`；规则是否真的被违反：`ontology_evaluate_rules`',
      '- 执行业务动作：`ontology_execute_action`（受审批闸门约束）',
      '- 所有写工具都支持 `dryRun` 预览；写入是否落盘以返回的 `ok` 为准，不要凭假设报告成功',
    ].join('\n');

  const full = render(level === 'full');
  if (full.length <= maxChars) return full;

  // Degrade: drop property detail, then truncate with an explicit marker.
  const terser = render(false);
  if (terser.length <= maxChars) return terser;

  // The marker itself costs characters, so it has to come out of the budget —
  // otherwise "bounded" is a lie and the caller's hard limit is quietly exceeded.
  const marker = (total) => `\n…（本体上下文已截断，共 ${total} 字符，可调大 contextMaxChars 或直接用 ontology_get 查询）`;
  const room = maxChars - marker(terser.length).length;
  if (room <= 0) return marker(terser.length).trim();
  return terser.slice(0, room) + marker(terser.length);
}
