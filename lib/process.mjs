/**
 * 业务流程编排：声明一串步骤，然后在事实数据上**推演**它现在能不能跑。
 *
 * 它是流程定义与推演，不是工作流引擎。刻意不做的：
 *   - 不落持久化运行实例（没有 run 表、没有恢复、没有补偿）
 *   - 不做定时 / 重试 / 并行网关 / 人工待办箱
 *   - 不偷偷替人执行：动作步骤只是**在副本上**演算，真正的执行仍走
 *     ontology_execute_action，一步一次审批
 *
 * 推演的用处是硬的：把「先看什么、谁批、批完会发生什么」变成可校验的声明，
 * 并且在跑之前就知道会卡在哪一步、卡住的原因是什么。
 */
import { evaluateRules } from './rules.mjs';
import { computeMetrics } from './metrics.mjs';
import { validateInput, applyEffects, executableActions } from './actions.mjs';

const KINDS = new Set(['check', 'action', 'gate']);

const findRule = (ir, id) => (ir.rules || []).find((r) => r.id === id) || null;
const findMetric = (ir, id) => (ir.metrics || []).find((m) => m.id === id) || null;
const findAction = (ir, id) => (ir.actions || []).find((a) => a.id === id) || null;

/** 声明本身的校验：引用的规则/指标/动作必须存在，动作必须可执行。 */
export function checkProcess(ir, process) {
  const problems = [];
  const steps = Array.isArray(process.steps) ? process.steps : [];
  if (!steps.length) {
    problems.push({ field: 'steps', code: 'empty', message: '流程至少要有一个步骤' });
    return { ok: false, problems };
  }
  const seen = new Set();
  steps.forEach((step, i) => {
    const at = `steps[${i}]`;
    if (!step || typeof step !== 'object') {
      problems.push({ field: at, code: 'not-object', message: '步骤必须是 JSON 对象' });
      return;
    }
    if (typeof step.id !== 'string' || step.id.trim() === '') {
      problems.push({ field: `${at}.id`, code: 'missing', message: '步骤 id 不能为空' });
    } else if (seen.has(step.id)) {
      problems.push({ field: `${at}.id`, code: 'duplicate', message: `同一个流程里步骤 id 重复：${step.id}` });
    } else {
      seen.add(step.id);
    }
    if (!KINDS.has(step.kind)) {
      problems.push({
        field: `${at}.kind`,
        code: 'bad-enum',
        message: `步骤类型只能是 check | action | gate，收到：${String(step.kind)}`,
      });
      return;
    }
    if (step.kind === 'check') {
      const hasRule = typeof step.ruleId === 'string';
      const hasMetric = typeof step.metricId === 'string';
      if (hasRule === hasMetric) {
        problems.push({ field: `${at}`, code: 'check-target', message: '检查步骤必须且只能声明 ruleId 或 metricId 之一' });
      }
      if (hasRule && !findRule(ir, step.ruleId)) {
        problems.push({ field: `${at}.ruleId`, code: 'dangling-rule', message: `规则不存在：${step.ruleId}` });
      }
      if (hasMetric && !findMetric(ir, step.metricId)) {
        problems.push({ field: `${at}.metricId`, code: 'dangling-metric', message: `指标不存在：${step.metricId}` });
      }
      for (const bound of ['min', 'max']) {
        if (step[bound] !== undefined && !Number.isFinite(Number(step[bound]))) {
          problems.push({ field: `${at}.${bound}`, code: 'bad-type', message: `${bound} 必须是数字` });
        }
      }
    }
    if (step.kind === 'action') {
      const action = findAction(ir, step.actionId);
      if (!action) {
        problems.push({ field: `${at}.actionId`, code: 'dangling-action', message: `动作不存在：${String(step.actionId)}` });
      } else if (!executableActions(ir).some((a) => a.id === action.id)) {
        problems.push({
          field: `${at}.actionId`,
          code: 'not-executable',
          message: `动作 ${action.id} 缺少 inputSchema 或 effect，推演不了`,
        });
      }
      if (step.input !== undefined && (typeof step.input !== 'object' || Array.isArray(step.input))) {
        problems.push({ field: `${at}.input`, code: 'bad-type', message: 'input 必须是对象' });
      }
    }
    if (step.onFail !== undefined && !['stop', 'continue'].includes(step.onFail)) {
      problems.push({ field: `${at}.onFail`, code: 'bad-enum', message: 'onFail 只能是 stop | continue' });
    }
  });
  return { ok: problems.length === 0, problems };
}

function checkStep(ir, records, step) {
  if (step.ruleId) {
    const evaluated = evaluateRules(ir, records);
    const hit = (evaluated.results || []).find((r) => r.rule === step.ruleId);
    if (!hit) return { verdict: 'blocked', detail: `规则 ${step.ruleId} 评估不了（可能被停用或表达式无法解析）` };
    const count = (hit.violations || []).length;
    return {
      verdict: count === 0 ? 'pass' : 'fail',
      value: count,
      detail: count === 0 ? `规则 ${step.ruleId} 无违规（评估 ${hit.evaluated} 行）` : `规则 ${step.ruleId} 有 ${count} 行违规`,
    };
  }

  const computed = computeMetrics(ir, records).find((m) => m.id === step.metricId);
  if (!computed) return { verdict: 'blocked', detail: `指标 ${step.metricId} 算不出来` };
  if (computed.problems && computed.problems.length) {
    return { verdict: 'blocked', detail: `${step.metricId} 算不了：${computed.problems[0].message}` };
  }
  const value = computed.value;
  const min = step.min === undefined ? null : Number(step.min);
  const max = step.max === undefined ? null : Number(step.max);
  const bits = [];
  let ok = true;
  if (value === null) {
    return { verdict: 'fail', value: null, detail: `${step.metricId} 没有可用数值（${computed.matched}/${computed.total} 行参与）` };
  }
  if (min !== null && value < min) {
    ok = false;
    bits.push(`应 ≥ ${min}`);
  }
  if (max !== null && value > max) {
    ok = false;
    bits.push(`应 ≤ ${max}`);
  }
  return {
    verdict: ok ? 'pass' : 'fail',
    value,
    detail: `${step.metricId} = ${value}` + (bits.length ? `（${bits.join('，')}）` : '（在允许范围内）'),
  };
}

function actionStep(ir, working, step) {
  const action = findAction(ir, step.actionId);
  const validation = validateInput(action, step.input === undefined ? {} : step.input);
  if (!validation.ok) {
    return {
      verdict: 'blocked',
      detail: `入参不合法：${(validation.problems || []).map((p) => p.message).join('；')}`,
      problems: validation.problems,
    };
  }
  const outcome = applyEffects(working, action, validation.value);
  const needsApproval = action.approvalRequired === true || (ir.policies || []).some(
    (p) => (p.appliesTo || []).includes(action.id) && p.effect === 'require-approval'
  );
  return {
    verdict: outcome.matched === 0 ? 'no-match' : 'would-run',
    matched: outcome.matched,
    updated: outcome.updated,
    approvalRequired: needsApproval,
    detail:
      outcome.matched === 0
        ? `${action.id} 没有匹配到任何记录（入参 ${JSON.stringify(validation.value)}）`
        : `${action.id} 会命中 ${outcome.matched} 行、更新 ${outcome.updated} 行` + (needsApproval ? '，需要审批' : ''),
  };
}

/**
 * 推演一个流程。
 *
 * 动作步骤在副本上真的演算（applyEffects），所以后面的检查看到的是
 * 「如果前面那步执行了」的数据——这是推演有别于干看的地方。
 */
export function planProcess(ir, records, process) {
  const checked = checkProcess(ir, process);
  if (!checked.ok) {
    return { id: process.id, ok: false, problems: checked.problems, steps: [], blockedAt: null, summary: '流程声明有问题，推演不了' };
  }

  const working = JSON.parse(JSON.stringify(records || { objects: {} }));
  const steps = [];
  let blockedAt = null;
  let needsHuman = false;

  for (let i = 0; i < process.steps.length; i += 1) {
    const step = process.steps[i];
    if (blockedAt !== null) {
      steps.push({ id: step.id, kind: step.kind, label: step.label || step.id, verdict: 'skipped', detail: '前面卡住了，这一步没推演' });
      continue;
    }

    let outcome;
    if (step.kind === 'check') outcome = checkStep(ir, working, step);
    else if (step.kind === 'action') outcome = actionStep(ir, working, step);
    else {
      needsHuman = true;
      outcome = {
        verdict: 'manual',
        detail: `需要人工确认${step.label ? '：' + step.label : ''}（推演不替人做决定）`,
      };
    }

    const failed = outcome.verdict === 'fail' || outcome.verdict === 'blocked' || outcome.verdict === 'no-match';
    const stop = failed && step.onFail !== 'continue';
    steps.push(Object.assign({ id: step.id, kind: step.kind, label: step.label || step.id, index: i }, outcome));
    if (stop && blockedAt === null) blockedAt = i;
  }

  const counts = steps.reduce((acc, s) => {
    acc[s.verdict] = (acc[s.verdict] || 0) + 1;
    return acc;
  }, {});
  const parts = [];
  if (counts.pass) parts.push(`${counts.pass} 步通过`);
  if (counts['would-run']) parts.push(`${counts['would-run']} 步会执行`);
  if (counts.manual) parts.push(`${counts.manual} 步待人确认`);
  if (counts.fail) parts.push(`${counts.fail} 步未通过`);
  if (counts.blocked) parts.push(`${counts.blocked} 步算不了`);
  if (counts['no-match']) parts.push(`${counts['no-match']} 步无匹配`);
  if (counts.skipped) parts.push(`${counts.skipped} 步被跳过`);

  const head =
    blockedAt === null
      ? `${process.steps.length} 步推演完毕：${parts.join('，')}`
      : `卡在第 ${blockedAt + 1} 步（${steps[blockedAt].label}）：${parts.join('，')}`;

  return {
    id: process.id,
    name: process.name,
    ok: true,
    steps,
    blockedAt,
    blockedReason: blockedAt === null ? null : steps[blockedAt].detail,
    needsHuman,
    canRun: blockedAt === null,
    summary: head,
  };
}

/**
 * 删掉对象之后清理流程：步骤引用的动作/指标/规则没了，就把那一步摘掉；
 * 整个流程一步不剩就一并删除（空流程等于一个永远报错的声明）。
 * @returns {string[]} 被改动或删除的流程 id
 */
export function trimProcessesAfterObjectDelete(ir, removed = {}) {
  const actions = new Set(removed.actions || []);
  const metrics = new Set(removed.metrics || []);
  const rules = new Set(removed.rules || []);
  if (!Array.isArray(ir.processes) || !ir.processes.length) return [];
  const touched = [];
  ir.processes = ir.processes
    .map((process) => {
      const before = process.steps || [];
      const steps = before.filter((step) => {
        if (step.kind === "action") return !actions.has(step.actionId);
        if (step.kind === "check") {
          if (step.metricId) return !metrics.has(step.metricId);
          if (step.ruleId) return !rules.has(step.ruleId);
        }
        return true;
      });
      if (steps.length !== before.length) touched.push(process.id);
      return Object.assign({}, process, { steps });
    })
    // 只剩「人工确认」的流程什么也不做，是空壳，一并删掉
    .filter((process) => (process.steps || []).some((step) => step.kind === 'action' || step.kind === 'check'));
  return touched;
}

/** 一句话描述流程结构，面板与工具共用。 */
export function describeProcess(process) {
  const kinds = { check: '检查', action: '执行', gate: '人工确认' };
  return (process.steps || [])
    .map((s) => `${kinds[s.kind] || s.kind}(${s.label || s.id})`)
    .join(' → ');
}
