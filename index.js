/**
 * Host half of the dsh-ontology-studio bundle.
 *
 * Phase 1 turns the ontology from a drawing into a machine-readable asset:
 * the Host reads `assets/*.ir.json`, validates it against the IR schema plus
 * the cross-reference rules a JSON Schema cannot express, and exposes the
 * result to the Agent as `ontology_*` tools. The panel in the Web GUI stays a
 * view over the same structure.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createStore, bumpVersion } from './lib/store.mjs';
import { impactOf, summarizeIr, validateIr } from './lib/ir.mjs';
import { registerRoutes } from './lib/api.mjs';
import { registerWriteRoutes } from './lib/panel-writes.mjs';
import { createTraceStore, summarizeCall } from './lib/trace.mjs';
import { evaluateRules, ruleWarnings } from './lib/rules.mjs';
import { validateInput, applyEffects, executableActions, policiesFor } from './lib/actions.mjs';
import { buildBrief } from './lib/context.mjs';
import { draftObjectFromTable, validateDraft } from './lib/reverse.mjs';
import { objectSchema, packageSchemas, markdownDoc } from './lib/export.mjs';
import { generateOpenApi } from './lib/openapi.mjs';
import { catalogState, installAsset, uninstallAsset } from './lib/registry.mjs';
import { generateAppSpec } from './lib/app.mjs';
import { diffPackages, describeDiff } from './lib/diff.mjs';
import { draftFromSample } from './lib/sample.mjs';
import { buildRegressionPlan } from './lib/regression.mjs';
import { applyLint } from './lib/lint.mjs';
import { focusOf, messageText } from './lib/focus.mjs';
import { harnessCheck } from './lib/harness-check.mjs';
import { runEvaluation, compareRuns } from './lib/evals.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Loaded code version; kept in sync with package.json by a test. */
const CODE_VERSION = '0.50.0';

/** Single source of the panel's HTTP namespace. */
const ROUTE_PREFIX = '/dsh-ontology-studio';

/** `tools` is a hard dependency: without it this plugin has nothing to offer. */
export const inject = ['tools'];

const text = (value) => [{ type: 'text', text: value }];

const lines = (items) => items.filter(Boolean).join('\n');

export function apply(ctx, config = {}) {
  const assetsDir = config.assetsDir ? path.resolve(config.assetsDir) : path.join(here, 'assets');
  const store = createStore({ dir: assetsDir });

  /** Catalog = packages available to install but not yet loaded. */
  const catalogDir = config.catalogDir ? path.resolve(config.catalogDir) : path.join(here, 'catalog');

  /** `readonly` removes write tools entirely; `open` (default) keeps them. */
  const writeMode = config.writeMode === 'readonly' ? 'readonly' : 'open';

  /** Which writes need a human decision: never | destructive (default) | all. */
  const approvalMode = ['never', 'destructive', 'all'].includes(config.approval) ? config.approval : 'destructive';

  /** Execution trace: one JSON line per tool call, readable by the panel. */
  const trace = createTraceStore({
    file: config.traceFile ? path.resolve(config.traceFile) : path.join(path.dirname(assetsDir), '.ontology-traces.jsonl'),
    maxLines: Number.isFinite(config.traceMaxLines) ? config.traceMaxLines : 500,
    enabled: config.trace !== false,
  });

  /**
   * Version history of the asset package itself: one line per mutation, so
   * "who changed what, and at which version" survives longer than the file's
   * current contents. Same append-only JSONL mechanics as the trace.
   */
  const history = createTraceStore({
    file: config.historyFile ? path.resolve(config.historyFile) : path.join(path.dirname(assetsDir), '.ontology-history.jsonl'),
    maxLines: Number.isFinite(config.historyMaxLines) ? config.historyMaxLines : 2000,
    enabled: config.history !== false,
  });

  /** Evaluation runs, so two results can be compared later under known conditions. */
  const evals = createTraceStore({
    file: config.evalFile ? path.resolve(config.evalFile) : path.join(path.dirname(assetsDir), '.ontology-evals.jsonl'),
    maxLines: Number.isFinite(config.evalMaxLines) ? config.evalMaxLines : 500,
    enabled: config.evals !== false,
  });

  const panel = createTraceStore({
    file: config.panelFile ? path.resolve(config.panelFile) : path.join(path.dirname(assetsDir), '.ontology-panel.jsonl'),
    maxLines: Number.isFinite(config.panelMaxLines) ? config.panelMaxLines : 300,
    enabled: config.panel !== false,
  });

  async function noteHistory(entry) {
    await history.append(entry);
  }

  /** Records file for rule evaluation: `<name>.ir.json` ↔ `<name>.records.json`. */
  const recordsFileFor = (assetsFile) => path.join(assetsDir, assetsFile.replace(/\.ir\.json$/, '.records.json'));

  /* ------------------------------------------------------------------ *
   * Context Engine: the ontology another agent already knows about.
   * ------------------------------------------------------------------ */
  const contextMode = ['off', 'brief', 'full'].includes(config.context) ? config.context : 'brief';
  const contextMaxChars = Number.isFinite(config.contextMaxChars) ? config.contextMaxChars : 4000;
  let briefCache = '';
  /** Task-layer focus: which objects the current turn seems to be about. */
  let lastFocus = null;
  /** How many times the observer actually ran (proof it is wired, not just registered). */
  let focusRuns = 0;
  let focusWired = false;
  let focusWhy = '未注册';
  const FOCUS_TTL_MS = 5 * 60 * 1000;

  async function refreshBrief() {
    if (contextMode === 'off') return;
    try {
      const { entries } = await store.list();
      const healthy = entries.filter((entry) => entry.ok && entry.ir)[0];
      briefCache = healthy ? buildBrief(healthy.ir, { maxChars: contextMaxChars, level: contextMode }) : '';
    } catch {
      briefCache = '';
    }
  }

  // Task-layer focus lives in lib/focus.mjs so it can be tested on its own.

  if (contextMode !== 'off') {
    void refreshBrief();

    // Observe-only: this listener never edits the step's messages. It only notes
    // what the turn looks like so the brief can add one advisory line.
    if (typeof ctx.on === 'function') {
      focusWired = true;
      focusWhy = '已注册';
    } else {
      focusWhy = 'ctx 上没有 on()，无法监听 agent/pre-step';
    }
    if (focusWired) {
      ctx.effect(() => {
        const onPreStep = async (payload, next) => {
          focusRuns += 1;
          try {
            const { entries } = await store.list();
            const healthy = entries.filter((entry) => entry.ok && entry.ir)[0];
            if (healthy) {
              const focused = focusOf(healthy.ir, messageText(payload && payload.messages));
              lastFocus = focused.length
                ? { objects: focused, at: Date.now(), agent: payload && payload.agent ? String(payload.agent.id) : null }
                : null;
            }
          } catch {
            /* observation must never disturb the step */
          }
          return next();
        };
        ctx.on('agent/pre-step', onPreStep);
        return () => {
          if (typeof ctx.off === 'function') ctx.off('agent/pre-step', onPreStep);
        };
      });
    }

    let disposeSection;
    ctx.inject(['systemPrompt'], (sysCtx) => {
      disposeSection = sysCtx.systemPrompt.section({
        name: 'ontology-studio',
        order: 700,
        text: () => {
          const base = briefCache || '（本体资产尚未加载完成；用 ontology_list 查看当前资产包。）';
          if (!lastFocus || Date.now() - lastFocus.at > FOCUS_TTL_MS) return base;
          const names = lastFocus.objects.map((o) => `${o.id}（${o.name}）`).join('、');
          return base + `\n\n> 本轮可能相关：${names}。需要细节时用 ontology_get 取。`;
        },
      });
    });

    ctx.effect(() => () => {
      if (typeof disposeSection === 'function') disposeSection();
    });
  }

  /** Writes change the brief, so the cache is rebuilt after every mutation. */
  const WRITE_TOOLS = new Set([
    'ontology_upsert_object',
    'ontology_upsert_link',
    'ontology_delete_object',
    'ontology_delete_link',
    'ontology_publish',
    'ontology_execute_action',
  ]);

  async function loadRecords(assetsFile) {
    const file = recordsFileFor(assetsFile);
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      return { file, records: parsed, problems: [] };
    } catch (error) {
      if (error && error.code === 'ENOENT') return { file, records: null, problems: ['没有找到示例数据文件：' + file] };
      return { file, records: null, problems: [`示例数据无法解析：${error && error.message}`] };
    }
  }

  /* The panel is a separate process; it reads the same store over HTTP. */
  ctx.inject(['webServer'], (webCtx) => {
    registerWriteRoutes(webCtx, {
      store,
      prefix: ROUTE_PREFIX,
      writeMode,
      noteHistory,
    });
    registerRoutes(webCtx, {
      store,
      version: CODE_VERSION,
      trace,
      history,
      panel,
      catalog: () => catalogState({ catalogDir, assetsDir: store.dir }),
      // Read-only: the panel may run this without an approval, because nothing
      // is written. Write operations stay tool-only on purpose.
      evaluate: async (id) => {
        const { entry } = await store.get(id);
        if (!entry || !entry.ir) return null;
        const loaded = await loadRecords(entry.file);
        if (!loaded.records) {
          return { packageId: id, available: false, message: loaded.problems.join('；') || '没有示例事实数据' };
        }
        const result = evaluateRules(entry.ir, loaded.records);
        return Object.assign({ packageId: id, available: true }, result);
      },
      // 只读：体检结果直接给面板，不走审批。
      // 只读分析，都不写盘。
      diff: async (id) => {
        const { entry } = await store.get(id);
        if (!entry || !entry.ir) return null;
        const state = await catalogState({ catalogDir, assetsDir: store.dir });
        const hit = state.available.find((e) => e.ir && e.ir.id === id && e.ir.version !== entry.ir.version);
        if (!hit) return { available: false, message: `市场里没有 ${id} 的其它版本` };
        const d = diffPackages(entry.ir, hit.ir);
        return { available: true, diff: d, summary: describeDiff(d) };
      },
      regression: async (id, objectId) => {
        const { entry } = await store.get(id);
        if (!entry || !entry.ir) return null;
        return buildRegressionPlan(entry.ir, objectId);
      },
      harness: async (id) => {
        const { entry } = await store.get(id);
        if (!entry || !entry.ir) return null;
        const loaded = await loadRecords(entry.file);
        return harnessCheck(entry.ir, { records: loaded.records || null });
      },
      agents: async (id) => {
        const { entry } = await store.get(id);
        if (!entry || !entry.ir) return null;
        const roster = entry.ir.agents || [];
        const declared = new Set(roster.map((a) => a.id));
        const entries = await trace.list(200);
        const byTool = {};
        let unattributed = 0;
        for (const item of entries) {
          const who = item.agent && declared.has(item.agent) ? item.agent : null;
          if (!who) {
            if (item.agent) unattributed += 1;
            continue;
          }
          byTool[who] = byTool[who] || {};
          byTool[who][item.tool] = byTool[who][item.tool] || { ok: 0, fail: 0 };
          if (item.ok) byTool[who][item.tool].ok += 1;
          else byTool[who][item.tool].fail += 1;
        }
        return { agents: roster, usage: { byTool, unattributed, scanned: entries.length } };
      },
      appSpec: async (id) => {
        const { entry } = await store.get(id);
        return entry && entry.ir ? generateAppSpec(entry.ir) : null;
      },
      prefix: ROUTE_PREFIX,
      readOnly: writeMode === 'readonly',
      approval: approvalMode,
    });
  });

  /**
   * Every tool is wrapped once: the trace records what ran, whether it
   * succeeded and how long it took. Tracing never fails a call.
   */
  const registeredTools = [];

  const register = (definition) => {
    const wrapped = Object.assign({}, definition, {
      execute: async (args, exec) => {
        const startedAt = Date.now();
        let ok = true;
        let error = null;
        try {
          const result = await definition.execute(args, exec);
          // Refusals are recorded as failures: a blocked delete or a missing
          // package is not a successful call, whatever the payload shape.
          ok = !(result && (result.ok === false || result.found === false || result.blocked === true));
          if (!ok && result && typeof result.message === 'string') error = result.message;
          return result;
        } catch (thrown) {
          ok = false;
          error = String(thrown && thrown.message ? thrown.message : thrown);
          throw thrown;
        } finally {
          await trace.append({
            ts: startedAt,
            tool: definition.name,
            ok,
            ms: Date.now() - startedAt,
            summary: summarizeCall(definition.name, args),
            error,
            agent: exec && exec.agent ? String(exec.agent.id) : null,
          });
          if (WRITE_TOOLS.has(definition.name)) void refreshBrief();
        }
      },
    });
    registeredTools.push(definition.name);
    ctx.effect(() => ctx.tools.register(wrapped));
  };

  /** Write tools disappear entirely in readonly mode — not a UI toggle. */
  const registerWrite = (definition) => {
    if (writeMode === 'readonly') return;
    // Every write tool supports compare-and-swap and reports the resulting etag.
    const params = definition.parameters || (definition.parameters = {});
    const props = params.properties || (params.properties = {});
    if (!props.ifEtag) {
      props.ifEtag = {
        type: 'string',
        description: '可选：读取时拿到的 etag。若资产在你读取后被改动过，本次写入会被拒绝（乐观锁）',
      };
    }
    const outProps = definition.output && definition.output.schema && definition.output.schema.properties;
    if (outProps) {
      if (!outProps.etag) outProps.etag = { type: 'string' };
      if (!outProps.conflict) outProps.conflict = { type: 'boolean' };
    }
    register(definition);
  };

  /**
   * Per-call approval gate: only `'allowed-once'` grants a write. A missing
   * service, a missing session, or a thrown request (what an idle turn yields)
   * all fail closed. Destructiveness and mode come from the caller.
   */
  async function gateWrite(exec, spec) {
    // A dry run changes nothing on disk, so it never needs a human decision.
    if (spec.dryRun === true) return { allowed: true, outcome: 'dry-run' };
    const needed = approvalMode === 'all' || (approvalMode === 'destructive' && spec.destructive === true);
    if (!needed) return { allowed: true, outcome: 'not-required' };

    const approval = ctx.get('approval');
    const agent = exec && exec.agent;
    if (!approval || typeof approval.request !== 'function' || !agent) {
      return {
        allowed: false,
        outcome: 'unavailable',
        message: '该写入需要人工审批，但审批服务不可用或当前没有会话上下文，已拒绝写入',
      };
    }
    try {
      const outcome = await approval.request({
        agent,
        toolName: spec.toolName,
        callId: exec.callId,
        reason: spec.reason,
        displayReason: { en: spec.reason, 'zh-CN': spec.reason },
        signal: exec.signal,
      });
      if (outcome === 'allowed-once') return { allowed: true, outcome };
      return {
        allowed: false,
        outcome,
        message:
          outcome === 'rejected'
            ? '人工审批被拒绝，未写入磁盘'
            : outcome === 'cancelled'
              ? '审批被取消，未写入磁盘'
              : '审批不可用（无应答方），已按失败关闭处理，未写入磁盘',
      };
    } catch (error) {
      return {
        allowed: false,
        outcome: 'unavailable',
        message: `审批请求失败（${error && error.message}），未写入磁盘`,
      };
    }
  }

  /* ------------------------------------------------------------------ *
   * ontology_list
   * ------------------------------------------------------------------ */
  register({
    name: 'ontology_list',
    description:
      '列出本体工作台里已登记的本体资产包（资产目录下的 *.ir.json），包含对象/关系/规则/动作数量与校验状态。回答"我们有哪些本体""库存对象在哪个包里"这类问题先用它。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          dir: { type: 'string' },
          packages: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                version: { type: 'string' },
                status: { type: 'string' },
                objects: { type: 'number' },
                links: { type: 'number' },
                rules: { type: 'number' },
                actions: { type: 'number' },
                ok: { type: 'boolean' },
                file: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value || {};
        const body = (v.packages || []).map(
          (p) =>
            `${p.ok ? '✓' : '✗'} ${p.id} v${p.version} (${p.status}) — ${p.objects} 对象 / ${p.links} 关系 / ${p.rules} 规则 / ${p.actions} 动作`
        );
        return text(lines([`资产目录：${v.dir}`, ...body]) || '资产目录为空');
      },
    },
    execute: async () => {
      const { dir, entries, missingDir } = await store.list();
      return {
        dir,
        missingDir,
        packages: entries.map((e) => ({
          id: e.ir ? e.ir.id : e.file,
          name: e.ir ? e.ir.name : e.file,
          version: e.ir ? e.ir.version : '—',
          status: e.ir ? e.ir.status ?? 'draft' : 'invalid',
          objects: e.summary ? e.summary.objects : 0,
          links: e.summary ? e.summary.links : 0,
          rules: e.summary ? e.summary.rules : 0,
          actions: e.summary ? e.summary.actions : 0,
          ok: e.ok,
          file: e.file,
        })),
      };
    },
  });

  /* ------------------------------------------------------------------ *
   * ontology_get
   * ------------------------------------------------------------------ */
  register({
    name: 'ontology_get',
    description:
      '读取一个本体资产包的结构。只给 packageId 时返回包摘要；同时给 objectId 时返回该对象的属性、关系、相关规则与动作——给 Agent 组织业务上下文用。',
    parameters: {
      type: 'object',
      properties: {
        packageId: { type: 'string', description: '资产包 id，例如 retail.store-inventory' },
        objectId: { type: 'string', description: '可选：对象 id，例如 Inventory' },
      },
      required: ['packageId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          found: { type: 'boolean' },
          package: { type: 'object' },
          objects: { type: 'array' },
          object: { type: 'object' },
          links: { type: 'array' },
          rules: { type: 'array' },
          actions: { type: 'array' },
          problems: { type: 'array' },
        },
      },
      render: (_args, value) => {
        const v = value || {};
        if (!v.found) return text(`未找到该本体包。${(v.problems || []).map((p) => p.message).join('; ')}`);
        if (v.object) {
          const props = (v.object.properties || []).map(
            (p) =>
              `  - ${p.name}${p.label ? '（' + p.label + '）' : ''}: ${p.type}${p.required ? ' 必填' : ''}${
                p.enum ? ' [' + p.enum.join('/') + ']' : ''
              }`
          );
          return text(
            lines([
              `${v.package.name} / ${v.object.name} (${v.object.id})`,
              v.object.description || '',
              '属性：',
              ...props,
              v.links && v.links.length ? `关系：${v.links.map((l) => `${l.type} → ${l.source === v.object.id ? l.target : l.source}`).join(', ')}` : '',
              v.actions && v.actions.length ? `可用动作：${v.actions.map((a) => a.id + (a.approvalRequired ? '(需审批)' : '')).join(', ')}` : '',
            ])
          );
        }
        return text(
          lines([
            `${v.package.name} (${v.package.id}) v${v.package.version} · ${v.package.status}`,
            `对象：${(v.objects || []).map((o) => o.id).join(', ')}`,
          ])
        );
      },
    },
    execute: async (args) => {
      const { entry, entries } = await store.get(args.packageId);
      if (!entry || !entry.ir) {
        return {
          found: false,
          problems: entry ? entry.problems : [{ message: `资产包不存在：${args.packageId}` }],
          available: entries.map((e) => (e.ir ? e.ir.id : e.file)),
        };
      }
      const ir = entry.ir;

      if (!args.objectId) {
        return {
          found: true,
          etag: entry.etag,
          package: summarizeIr(ir),
          objects: (ir.objects || []).map((o) => ({
            id: o.id,
            name: o.name,
            properties: (o.properties || []).length,
            keys: o.keys || [],
          })),
        };
      }

      const obj = (ir.objects || []).find((o) => o.id === args.objectId);
      if (!obj) {
        return {
          found: false,
          package: summarizeIr(ir),
          problems: [{ message: `对象不存在：${args.objectId}` }],
          objects: (ir.objects || []).map((o) => ({ id: o.id, name: o.name })),
        };
      }
      const links = (ir.links || []).filter((l) => l.source === obj.id || l.target === obj.id);
      const actions = (ir.actions || []).filter((a) => (a.writes || []).includes(obj.id));
      const propNames = new Set((obj.properties || []).map((p) => p.name));
      const rules = (ir.rules || []).filter((r) =>
        [...propNames].some((n) => new RegExp(`\\b${n}\\b`).test(String(r.expression || '')))
      );
      return { found: true, etag: entry.etag, package: summarizeIr(ir), object: obj, links, rules, actions };
    },
  });

  /* ------------------------------------------------------------------ *
   * ontology_validate
   * ------------------------------------------------------------------ */
  register({
    name: 'ontology_validate',
    description:
      '校验本体资产包：结构是否符合 IR Schema，以及关系端点、主键、动作写入对象、策略指向动作等跨引用是否成立。改完 JSON 后先跑它，不要靠肉眼查。',
    parameters: {
      type: 'object',
      properties: {
        packageId: { type: 'string', description: '可选：只校验这一个包' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          dir: { type: 'string' },
          checked: { type: 'array' },
          problems: { type: 'array' },
        },
      },
      render: (_args, value) => {
        const v = value || {};
        if (v.ok) {
          const extraWarnings = (v.warnings || []).length
            ? `\n另有 ${v.warnings.length} 条规则永远不会触发（不阻断发布）：\n` +
              v.warnings.map((w) => `  ${w.rule} — ${w.message}`).join('\n')
            : '';
          const extraLint = (v.lint || []).length
            ? `\n另有 ${v.lint.length} 条团队约定建议（不阻断写入）：\n` + v.lint.map((p) => `  [${p.code}] ${p.path} — ${p.message}`).join('\n')
            : '';
          return text(`✓ ${(v.checked || []).length} 个本体包全部通过校验（${v.dir}）` + extraWarnings + extraLint);
        }
        return text(
          lines([
            `✗ 发现 ${(v.problems || []).length} 个问题：`,
            ...(v.problems || []).map((p) => `  [${p.code}] ${p.package || ''}${p.path} — ${p.message}`),
          ])
        );
      },
    },
    execute: async (args) => {
      const { dir, entries, missingDir } = await store.list();
      const scope = args.packageId
        ? entries.filter((e) => (e.ir ? e.ir.id === args.packageId : e.file === args.packageId))
        : entries;
      const problems = [];
      if (missingDir) {
        problems.push({ package: null, path: dir, code: 'missing-dir', message: '资产目录不存在' });
      }
      if (args.packageId && scope.length === 0) {
        problems.push({ package: args.packageId, path: '$', code: 'not-found', message: '资产包不存在' });
      }
      for (const entry of scope) {
        const packageId = entry.ir ? entry.ir.id : entry.file;
        for (const p of entry.problems) {
          problems.push({ package: packageId, path: p.path, code: p.code, message: p.message });
        }
      }
      // Rules that can never fire are warnings, not errors: a package may
      // legitimately declare a rule before the properties exist.
      const warnings = [];
      for (const entry of scope) {
        if (!entry.ir) continue;
        for (const w of ruleWarnings(entry.ir)) warnings.push(Object.assign({ package: entry.ir.id }, w));
      }

      // Team conventions (config.lintRules) are reported separately: they never
      // block a write, because a convention must not be able to wedge the platform.
      const lint = [];
      for (const entry of scope) {
        if (!entry.ir) continue;
        for (const p of applyLint(entry.ir, config.lintRules)) {
          lint.push(Object.assign({ package: entry.ir.id }, p));
        }
      }

      return {
        ok: problems.length === 0,
        dir,
        checked: scope.map((e) => (e.ir ? e.ir.id : e.file)),
        problems,
        lint,
        warnings,
      };
    },
  });

  /* ------------------------------------------------------------------ *
   * ontology_impact
   * ------------------------------------------------------------------ */
  register({
    name: 'ontology_impact',
    description:
      '对本体的某个对象做影响分析：改它会影响哪些关系、规则、动作、审批策略。发布前的回归范围判断用它，而不是事后从失败里倒推。',
    parameters: {
      type: 'object',
      properties: {
        packageId: { type: 'string' },
        objectId: { type: 'string' },
      },
      required: ['packageId', 'objectId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          found: { type: 'boolean' },
          object: { type: 'object' },
          outgoingLinks: { type: 'array' },
          incomingLinks: { type: 'array' },
          rules: { type: 'array' },
          actions: { type: 'array' },
          policies: { type: 'array' },
          dependents: { type: 'number' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value || {};
        if (!v.found) return text(v.message || '未找到该对象');
        return text(
          lines([
            `${v.object.name} (${v.object.id}) 有 ${v.dependents} 个直接下游依赖`,
            (v.outgoingLinks || []).length ? `出向关系：${v.outgoingLinks.map((l) => l.type + ' → ' + l.target).join(', ')}` : '',
            (v.incomingLinks || []).length ? `入向关系：${v.incomingLinks.map((l) => l.source + ' → ' + l.type).join(', ')}` : '',
            (v.rules || []).length ? `引用其属性的规则：${v.rules.map((r) => r.id).join(', ')}` : '',
            (v.actions || []).length ? `写它的动作：${v.actions.map((a) => a.id).join(', ')}` : '',
            (v.policies || []).length ? `相关审批策略：${v.policies.map((p) => p.id).join(', ')}` : '',
          ])
        );
      },
    },
    execute: async (args) => {
      const { entry } = await store.get(args.packageId);
      if (!entry || !entry.ir) {
        return { found: false, message: `资产包不存在：${args.packageId}` };
      }
      const impact = impactOf(entry.ir, args.objectId);
      if (!impact) {
        return {
          found: false,
          message: `对象不存在：${args.objectId}。可用对象：${(entry.ir.objects || []).map((o) => o.id).join(', ')}`,
        };
      }
      return { found: true, ...impact };
    },
  });

  /* ------------------------------------------------------------------ *
   * ontology_evaluate_rules  (read)
   * ------------------------------------------------------------------ */
  register({
    name: 'ontology_evaluate_rules',
    description:
      '用示例事实数据真正求值本体里的业务规则（不是只看表达式字符串）。规则归属于哪个对象由它引用的属性推导；推不出来的会列为 skipped 并说明原因，而不是默认通过。返回每条规则的求值行数、违规详情与汇总。',
    parameters: {
      type: 'object',
      properties: {
        packageId: { type: 'string' },
        objectId: { type: 'string', description: '可选：只看某个对象的规则结果' },
      },
      required: ['packageId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          packageId: { type: 'string' },
          recordsFile: { type: 'string' },
          summary: { type: 'object' },
          results: { type: 'array' },
          skipped: { type: 'array' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value || {};
        if (!v.ok) return text(`求值失败：${v.message || '未知原因'}`);
        const s = v.summary || {};
        const lines = [
          `规则求值：${s.evaluated} 条生效 / ${s.rules} 条声明，扫描 ${s.rows} 行数据`,
          `违规：${s.violations} 处，涉及 ${s.violatingRules} 条规则`,
        ];
        for (const r of v.results || []) {
          const mark = r.violations.length ? '✗' : '✓';
          lines.push(
            `${mark} ${r.rule}（${r.object}，${r.evaluated} 行）${r.violations.length ? ' → ' + r.violations.length + ' 处违规' : ''}`
          );
          for (const violation of (r.violations || []).slice(0, 3)) {
            lines.push(
              violation.error
                ? `    row ${violation.row}: ${violation.error}`
                : `    row ${violation.row}: ${JSON.stringify(violation.values)}`
            );
          }
        }
        for (const s2 of v.skipped || []) lines.push(`- 跳过 ${s2.rule}：${s2.reason}`);
        return text(lines.join('\n'));
      },
    },
    execute: async (args) => {
      const { entry } = await store.get(args.packageId);
      if (!entry || !entry.ir) {
        return { ok: false, packageId: args.packageId, message: `资产包不存在：${args.packageId}` };
      }
      const loaded = await loadRecords(entry.file);
      if (!loaded.records) {
        return { ok: false, packageId: entry.ir.id, recordsFile: loaded.file, message: loaded.problems.join('；') };
      }
      if (args.objectId && !(entry.ir.objects || []).some((o) => o.id === args.objectId)) {
        return {
          ok: false,
          packageId: entry.ir.id,
          message: `对象不存在：${args.objectId}。可用对象：${(entry.ir.objects || []).map((o) => o.id).join(', ')}`,
        };
      }

      const evaluation = evaluateRules(entry.ir, loaded.records);
      const results = (args.objectId ? evaluation.results.filter((r) => r.object === args.objectId) : evaluation.results).map(
        (r) => Object.assign({}, r, { violations: r.violations.slice(0, 10) })
      );
      return {
        ok: true,
        packageId: entry.ir.id,
        recordsFile: loaded.file,
        summary: evaluation.summary,
        results,
        skipped: evaluation.skipped,
      };
    },
  });

  /* ------------------------------------------------------------------ *
   * ontology_draft_object  (read — generates, never writes)
   * ------------------------------------------------------------------ */
  register({
    name: 'ontology_draft_object',
    description:
      '反向建模：给一张物理表的描述（列名、类型、注释、主键），生成可直接入库的本体对象草稿——类型映射、命名归一、主键推断、外键列的关系建议，并在目标包副本上预校验。本工具只生成不写入；确认后用 ontology_upsert_object 落库。',
    parameters: {
      type: 'object',
      properties: {
        packageId: { type: 'string', description: '要并入哪个资产包（用于关系推断与预校验）' },
        table: {
          type: 'object',
          description: '{ name, comment?, columns: [{ name, type, comment?, nullable?, primaryKey? }] }',
        },
      },
      required: ['packageId', 'table'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          object: { type: 'object' },
          links: { type: 'array' },
          problems: { type: 'array' },
          valid: { type: 'boolean' },
          validationProblems: { type: 'array' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value || {};
        if (!v.ok) return text(`生成失败：${v.message || '未知原因'}`);
        const obj = v.object;
        const lines = [
          `草稿对象 ${obj.id}（${obj.name}）：${obj.properties.length} 个属性，主键 ${(obj.keys || []).join('+') || '未识别'}`,
          ...obj.properties.map((p) => `  - ${p.name}${p.label ? '（' + p.label + '）' : ''}: ${p.type}${p.required ? ' 必填' : ''}${p.enum ? ' [' + p.enum.join('/') + ']' : ''}`),
          v.links && v.links.length ? `关系建议：${v.links.map((l) => `${l.id} → ${l.target}`).join(', ')}` : '关系建议：无',
          v.valid ? '预校验：并入后整包仍然合法' : `预校验：并入后不合法（${(v.validationProblems || []).length} 个问题）`,
          ...(v.problems || []).map((p) => `注意 [${p.code}] ${p.message}`),
          '确认后用 ontology_upsert_object 落库（本工具不写盘）。',
        ];
        return text(lines.join('\n'));
      },
    },
    execute: async (args) => {
      const { entry } = await store.get(args.packageId);
      if (!entry || !entry.ir) {
        return { ok: false, message: `资产包不存在：${args.packageId}` };
      }
      const draft = draftObjectFromTable(args.table, entry.ir);
      if (!draft.object) {
        return { ok: false, problems: draft.problems, message: (draft.problems[0] || {}).message || '无法生成' };
      }
      const check = validateDraft(entry.ir, draft);
      const validation = validateIr(JSON.parse(JSON.stringify(check.candidate)));
      return {
        ok: true,
        object: draft.object,
        links: draft.links,
        problems: draft.problems,
        valid: validation.ok,
        validationProblems: validation.problems,
      };
    },
  });

  /* ------------------------------------------------------------------ *
   * ontology_diagnostics  (read — "is this installation actually wired?")
   * ------------------------------------------------------------------ */
  register({
    name: 'ontology_diagnostics',
    description:
      '自检：报告当前加载的插件版本、资产目录与资产包状态、写入门禁与审批档位、上下文简报是否就绪、可选的宿主服务（approval / systemPrompt / webServer）是否存在、执行轨迹是否可写。刚装完或刚重启后先跑它，比逐个工具试错快。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          version: { type: 'string' },
          config: { type: 'object' },
          checks: { type: 'array' },
        },
      },
      render: (_args, value) => {
        const v = value || {};
        const lines = [`本体工作台 v${v.version || '?'} 自检：${v.ok ? '正常' : '有问题需要处理'}`];
        for (const check of v.checks || []) {
          const mark = check.status === 'ok' ? '✓' : check.status === 'warn' ? '!' : '✗';
          lines.push(`${mark} ${check.name}：${check.detail}`);
        }
        return text(lines.join('\n'));
      },
    },
    execute: async () => {
      const checks = [];
      const add = (name, status, detail) => checks.push({ name, status, detail });

      let version = 'unknown';
      let onDisk = null;
      try {
        const pkg = JSON.parse(await readFile(path.join(here, 'package.json'), 'utf8'));
        onDisk = pkg.version;
        version = pkg.version;
      } catch (error) {
        add('插件版本', 'warn', `读不到 package.json：${error.message}`);
      }

      // The host does not hot-reload its half: after an upgrade the loaded module
      // can be older than what is on disk, and an asset written for the newer
      // format then fails validation for reasons that look like data errors.
      if (onDisk && onDisk !== CODE_VERSION) {
        add(
          '版本一致',
          'fail',
          `运行中的代码是 v${CODE_VERSION}，磁盘上的包是 v${onDisk}：需要重启宿主才能加载新代码`
        );
      } else {
        add('版本一致', 'ok', `v${CODE_VERSION}`);
      }

      const { entries, missingDir } = await store.list();
      if (missingDir) {
        add('资产目录', 'fail', `不存在：${store.dir}`);
      } else {
        add('资产目录', 'ok', `${store.dir}（${entries.length} 个资产包）`);
      }
      const healthy = entries.filter((e) => e.ok);
      if (entries.length === 0) add('资产包', 'warn', '目录里没有 *.ir.json');
      else if (healthy.length !== entries.length) {
        add('资产包', 'fail', `${entries.length - healthy.length} 个未通过校验，用 ontology_validate 看详情`);
      } else add('资产包', 'ok', `${healthy.length} 个全部通过校验`);

      add(
        '写入能力',
        writeMode === 'readonly' ? 'warn' : 'ok',
        writeMode === 'readonly' ? '只读模式：写工具未注册' : `可写（审批档位 ${approvalMode}）`
      );

      if (contextMode === 'off') {
        add('上下文简报', 'warn', 'context: off，未注入系统提示');
      } else if (briefCache) {
        add('上下文简报', 'ok', `${briefCache.length} 字符，已就绪`);
      } else {
        add('上下文简报', 'warn', '尚未生成（初次装配或没有可用资产包）');
      }

      add('工具注册', 'ok', `${registeredTools.length} 个（${writeMode === 'readonly' ? '只读' : '读写'}）：${registeredTools.join(', ')}`);

      for (const [name, service] of [
        ['approval', ctx.get('approval')],
        ['systemPrompt', ctx.get('systemPrompt')],
        ['webServer', ctx.get('webServer')],
      ]) {
        add(`服务 ${name}`, service ? 'ok' : 'warn', service ? '可用' : '不可用（相关能力降级）');
      }

      if (trace.enabled) {
        try {
          await trace.append({ ts: Date.now(), tool: 'ontology_diagnostics', ok: true, ms: 0, summary: '自检探针', error: null });
          const recent = await trace.list(1);
          add('执行轨迹', recent.length ? 'ok' : 'warn', `${trace.file}（可写）`);
        } catch (error) {
          add('执行轨迹', 'fail', `不可写：${error.message}`);
        }
      } else {
        add('执行轨迹', 'warn', 'trace: false，已关闭');
      }

      // The panel reports its own render health; a page that throws shows up here
      // instead of only in someone's screenshot.
      if (panel.enabled) {
        try {
          const reports = await panel.list(50);
          const withVersion = reports.filter((r) => r && r.v);
          if (withVersion.length) {
            const latest = withVersion[0].v;
            if (latest !== version) {
              add('面板版本', 'warn', `面板跑的是 v${latest}，宿主是 v${version}：刷新页面（F5）即可`);
            } else {
              add('面板版本', 'ok', 'v' + latest);
            }
          } else {
            add('面板版本', 'warn', '面板还没上报过版本（旧客户端缓存），刷新页面后可比对');
          }
          const pageErrors = reports.filter((r) => r && r.phase === 'page-error');
          if (pageErrors.length) {
            const latest = pageErrors[0];
            add('面板渲染', 'fail', `${pageErrors.length} 次页面错误，最近：${latest.page || '?'} — ${latest.error || '未知'}`);
          } else {
            add('面板渲染', 'ok', reports.length ? `最近 ${reports.length} 次上报无错误` : '暂无上报（面板未打开过）');
          }
        } catch (error) {
          add('面板渲染', 'warn', `读取上报失败：${error.message}`);
        }
      } else {
        add('面板渲染', 'warn', 'panel: false，已关闭');
      }

      try {
        const state = await catalogState({ catalogDir, assetsDir: store.dir });
        const upgradable = state.available.filter((e) => e.upgradable).length;
        add(
          '资产市场',
          state.missingDeps.length ? 'warn' : 'ok',
          `可安装 ${state.available.length - state.installedIds.size} / 可升级 ${upgradable} / 依赖缺失 ${state.missingDeps.length}`
        );
      } catch (error) {
        add('资产市场', 'warn', `读取失败：${error.message}`);
      }

      // Task-layer focus is fresh-only; showing it makes the mechanism observable
      // instead of something you have to take on faith.
      if (contextMode === 'off') {
        add('上下文聚焦', 'warn', 'context: off，未启用');
      } else if (!lastFocus) {
        add('上下文聚焦', focusRuns ? 'ok' : 'warn', `${focusWhy}；已观察 ${focusRuns} 轮；最近一轮没有提到任何对象`);
      } else if (Date.now() - lastFocus.at > FOCUS_TTL_MS) {
        add('上下文聚焦', 'ok', `上一轮聚焦已过期（${lastFocus.objects.map((o) => o.id).join(', ')}）`);
      } else {
        add('上下文聚焦', 'ok', `已观察 ${focusRuns} 轮；上一轮提到：${lastFocus.objects.map((o) => o.id + '(' + o.score + ')').join(', ')}`);
      }

      const failing = checks.filter((c) => c.status === 'fail');
      return {
        ok: failing.length === 0,
        version,
        config: { writeMode, approval: approvalMode, context: contextMode, contextMaxChars, assetsDir: store.dir },
        checks,
      };
    },
  });

  /* ------------------------------------------------------------------ *
   * ontology_records  (read — the fact data actions run against)
   * ------------------------------------------------------------------ */
  register({
    name: 'ontology_records',
    description:
      '查看本体包对应的示例事实数据（*.records.json）：每个对象有多少行、字段样例。规则求值与动作执行都跑在这份数据上，用它确认「我说的那行数据到底长什么样」，不要凭规则结论反推数据。',
    parameters: {
      type: 'object',
      properties: {
        packageId: { type: 'string' },
        objectId: { type: 'string', description: '可选：只看一个对象的行' },
        limit: { type: 'number', description: '每个对象最多返回多少行（默认 5，上限 50）' },
      },
      required: ['packageId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          file: { type: 'string' },
          totalRows: { type: 'number' },
          objects: { type: 'array' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value || {};
        if (!v.ok) return text(`读取失败：${v.message || '未知原因'}`);
        const lines = [`事实数据：${v.totalRows} 行（${v.file}）`];
        for (const obj of v.objects || []) {
          lines.push(`${obj.id}：${obj.rows} 行`);
          for (const row of obj.sample || []) lines.push('  ' + JSON.stringify(row));
          if (obj.rows > (obj.sample || []).length) lines.push(`  …还有 ${obj.rows - obj.sample.length} 行`);
        }
        return text(lines.join('\n'));
      },
    },
    execute: async (args) => {
      const { entry } = await store.get(args.packageId);
      if (!entry || !entry.ir) return { ok: false, message: `资产包不存在：${args.packageId}` };
      if (args.objectId && !(entry.ir.objects || []).some((o) => o.id === args.objectId)) {
        return {
          ok: false,
          message: `对象不存在：${args.objectId}。可用对象：${(entry.ir.objects || []).map((o) => o.id).join(', ')}`,
        };
      }
      const loaded = await loadRecords(entry.file);
      if (!loaded.records) return { ok: false, file: loaded.file, message: loaded.problems.join('；') };

      const limit = Math.max(1, Math.min(Number.isFinite(args.limit) ? args.limit : 5, 50));
      const all = loaded.records.objects || {};
      const ids = args.objectId ? [args.objectId] : Object.keys(all);
      const objects = ids.map((id) => {
        const rows = Array.isArray(all[id]) ? all[id] : [];
        return { id, rows: rows.length, sample: rows.slice(0, limit) };
      });
      return {
        ok: true,
        file: loaded.file,
        totalRows: Object.keys(all).reduce((n, key) => n + (Array.isArray(all[key]) ? all[key].length : 0), 0),
        objects,
      };
    },
  });

  /* ------------------------------------------------------------------ *
   * ontology_history  (read — the package's own version history)
   * ------------------------------------------------------------------ */
  register({
    name: 'ontology_history',
    description:
      '查看本体包的变更历史：谁在哪个版本上改了什么（新增/更新/删除对象与关系、发布、执行动作）。文件内容只反映当前状态，历史记录才是「改过什么」的答案。',
    parameters: {
      type: 'object',
      properties: {
        packageId: { type: 'string', description: '可选：只看某个资产包' },
        limit: { type: 'number', description: '最多返回多少条（默认 20，上限 200）' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          file: { type: 'string' },
          entries: { type: 'array' },
        },
      },
      render: (_args, value) => {
        const v = value || {};
        if (!v.entries || v.entries.length === 0) return text('还没有任何变更记录。');
        const lines = [`变更历史（${v.entries.length} 条，新→旧）：${v.file}`];
        for (const e of v.entries) {
          const when = new Date(e.ts).toISOString().slice(0, 19).replace('T', ' ');
          lines.push(`${when}  v${e.version || '?'}  [${e.op}]  ${e.summary || e.target || ''}`);
        }
        return text(lines.join('\n'));
      },
    },
    execute: async (args) => {
      const limit = Math.max(1, Math.min(Number.isFinite(args.limit) ? args.limit : 20, 200));
      const all = await history.list(limit * 5);
      const filtered = args.packageId ? all.filter((e) => e.packageId === args.packageId) : all;
      return { ok: true, file: history.file, entries: filtered.slice(0, limit) };
    },
  });

  /* ------------------------------------------------------------------ *
   * ontology_export  (read — IR to downstream artifacts)
   * ------------------------------------------------------------------ */
  register({
    name: 'ontology_export',
    description:
      '把本体导出成其它系统能消费的产物：json-schema（按对象生成校验用 JSON Schema，draft 2020-12）或 markdown（人读的参考文档：对象/属性/关系/规则/动作/策略）。只返回内容，不写文件。',
    parameters: {
      type: 'object',
      properties: {
        packageId: { type: 'string' },
        format: { type: 'string', description: 'json-schema（默认）| markdown | openapi' },
        objectId: { type: 'string', description: 'json-schema 时可只导出一个对象' },
      },
      required: ['packageId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          format: { type: 'string' },
          content: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value || {};
        if (!v.ok) return text(`导出失败：${v.message || '未知原因'}`);
        return text(`导出完成（${v.format}，${v.content.length} 字符）\n\n${v.content}`);
      },
    },
    execute: async (args) => {
      const { entry } = await store.get(args.packageId);
      if (!entry || !entry.ir) return { ok: false, message: `资产包不存在：${args.packageId}` };
      const ir = entry.ir;
      const format =
        args.format === 'markdown' ? 'markdown' : args.format === 'openapi' ? 'openapi' : 'json-schema';

      if (format === 'openapi') {
        const doc = generateOpenApi(entry.ir);
        const text2 = JSON.stringify(doc, null, 2);
        return { ok: true, format: 'openapi', packageId: entry.ir.id, chars: text2.length, pathCount: Object.keys(doc.paths).length, schemaCount: Object.keys(doc.components.schemas).length, notes: doc.notes, content: text2 };
      }

      if (format === 'markdown') {
        if (args.objectId) {
          return { ok: false, format, message: 'markdown 导出的是整包文档，不接受 objectId' };
        }
        return { ok: true, format, content: markdownDoc(ir) };
      }

      if (args.objectId) {
        const object = (ir.objects || []).find((o) => o.id === args.objectId);
        if (!object) {
          return {
            ok: false,
            format,
            message: `对象不存在：${args.objectId}。可用对象：${(ir.objects || []).map((o) => o.id).join(', ')}`,
          };
        }
        return { ok: true, format, content: JSON.stringify(objectSchema(ir, object), null, 2) };
      }
      return { ok: true, format, content: JSON.stringify(packageSchemas(ir), null, 2) };
    },
  });

  /* ------------------------------------------------------------------ *
   * Asset registry: catalog, install, uninstall
   * ------------------------------------------------------------------ */
  register({
    name: 'ontology_asset_catalog',
    description:
      '资产市场：列出可安装的资产包（catalog 目录）与已安装的资产包，标注依赖是否满足、是否已安装。回答「还有哪些包可以装」「这个包依赖谁」用它。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          available: { type: 'array' },
          installed: { type: 'array' },
          missingDeps: { type: 'array' },
        },
      },
      render: (_args, value) => {
        const v = value || {};
        const lines = ['资产市场：'];
        lines.push(`可安装（${(v.available || []).length}）：`);
        for (const a of v.available || []) {
          lines.push(
            `  ${a.upgradable ? '↑ 可升级 v' + a.installedVersion + ' → v' + a.version : a.installed ? '✓ 已安装' : '· 可安装'} ${a.id} v${a.version} — ${a.objects} 对象 / ${a.rules} 规则 / ${a.actions} 动作${
              a.dependsOn && a.dependsOn.length ? '；依赖 ' + a.dependsOn.join(', ') : ''
            }`
          );
        }
        lines.push(`已安装（${(v.installed || []).length}）：`);
        for (const i of v.installed || []) lines.push(`  ${i.id} v${i.version}（${i.objects} 对象）`);
        if ((v.missingDeps || []).length) {
          lines.push('依赖缺失：');
          for (const m of v.missingDeps) lines.push(`  ${m.package} 需要 ${m.missing}`);
        }
        return text(lines.join('\n'));
      },
    },
    execute: async () => {
      const state = await catalogState({ catalogDir, assetsDir: store.dir });
      const shape = (entry) => ({
        id: entry.ir ? entry.ir.id : entry.file,
        name: entry.ir ? entry.ir.name : entry.file,
        version: entry.ir ? entry.ir.version : '—',
        status: entry.ir ? entry.ir.status || 'draft' : 'invalid',
        objects: entry.summary ? entry.summary.objects : 0,
        rules: entry.summary ? entry.summary.rules : 0,
        actions: entry.summary ? entry.summary.actions : 0,
        dependsOn: entry.ir ? entry.ir.dependsOn || [] : [],
        ok: entry.ok,
        file: entry.file,
      });
      return {
        ok: true,
        available: state.available.map((entry) =>
          Object.assign(shape(entry), {
            installed: entry.installed === true,
            installedVersion: entry.installedVersion || null,
            upgradable: entry.upgradable === true,
          })
        ),
        installed: state.installed.map(shape),
        missingDeps: state.missingDeps,
      };
    },
  });

  registerWrite({
    name: 'ontology_install_asset',
    description:
      '从资产市场安装一个资产包：复制到资产目录。依赖未安装时拒绝，包不合法时拒绝，已安装则拒绝。',
    parameters: {
      type: 'object',
      properties: { packageId: { type: 'string' } },
      required: ['packageId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          packageId: { type: 'string' },
          version: { type: 'string' },
          file: { type: 'string' },
          missing: { type: 'array' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value || {};
        if (v.ok) return text(`已安装 ${v.packageId} v${v.version} → ${v.file}`);
        return text(`未安装：${v.message || '未知原因'}`);
      },
    },
    execute: async (args) => {
      const result = await installAsset({ catalogDir, assetsDir: store.dir }, args.packageId);
      if (result.ok) await refreshBrief();
      return result;
    },
  });

  registerWrite({
    name: 'ontology_uninstall_asset',
    description: '卸载一个已安装的资产包：从资产目录删除。若其它已安装的包依赖它则拒绝。',
    parameters: {
      type: 'object',
      properties: { packageId: { type: 'string' } },
      required: ['packageId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          packageId: { type: 'string' },
          requiredBy: { type: 'array' },
          file: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value || {};
        if (v.ok) return text(`已卸载 ${v.packageId}`);
        return text(`未卸载：${v.message || '未知原因'}`);
      },
    },
    execute: async (args) => {
      const result = await uninstallAsset({ catalogDir, assetsDir: store.dir }, args.packageId);
      if (result.ok) await refreshBrief();
      return result;
    },
  });

  /* ------------------------------------------------------------------ *
   * ontology_generate_app  (read — metadata to page spec)
   * ------------------------------------------------------------------ */
  register({
    name: 'ontology_generate_app',
    description:
      '从本体元数据生成页面规格：列表列、筛选器、详情字段、以及由动作 inputSchema 派生的操作表单。应用依赖 Ontology 定义而不是底层表结构，所以属性一变规格就跟着变。只生成规格，不产出代码、不写文件。',
    parameters: {
      type: 'object',
      properties: {
        packageId: { type: 'string' },
        objects: {
          type: 'array',
          description: '可选：只给这些对象生成页面（默认全部）',
          items: { type: 'string' },
        },
      },
      required: ['packageId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, spec: { type: 'object' }, message: { type: 'string' } },
      },
      render: (_args, value) => {
        const v = value || {};
        if (!v.ok) return text(`生成失败：${v.message || '未知原因'}`);
        const s = v.spec;
        const lines = [`${s.title} · 应用规格（${s.pageCount} 页，来自 ${s.generatedFrom.packageId} v${s.generatedFrom.version}）`];
        for (const page of s.pages) {
          lines.push(`\n${page.title}（${page.kind}）：${page.columns.length} 列，${page.filters.length} 个筛选器`);
          lines.push('  列：' + page.columns.map((c) => c.label + (c.display === 'badge' ? '[枚举]' : '')).join(' / '));
          if (page.filters.length) lines.push('  筛选：' + page.filters.map((f) => `${f.label}(${f.kind})`).join(' / '));
          for (const action of page.actions) {
            lines.push(
              `  操作：${action.label}${action.approvalRequired ? '（需审批）' : ''} — 表单 ${action.form
                .map((f) => f.field + (f.required ? '*' : ''))
                .join(', ')}`
            );
          }
        }
        for (const note of s.notes || []) lines.push(`注意：${note}`);
        return text(lines.join('\n'));
      },
    },
    execute: async (args) => {
      const { entry } = await store.get(args.packageId);
      if (!entry || !entry.ir) return { ok: false, message: `资产包不存在：${args.packageId}` };
      return { ok: true, spec: generateAppSpec(entry.ir, { objects: args.objects }) };
    },
  });

  /* ------------------------------------------------------------------ *
   * ontology_agents  (read — declared roster + observed usage)
   * ------------------------------------------------------------------ */
  register({
    name: 'ontology_agents',
    description:
      '查看使用本资产包的 Agent：花名册是本体包里声明的（依赖哪些对象/Skill/工具/动作、评测口径），运行数据来自执行轨迹（最近调用次数、成功率）。声明与证据分开，不把两者混成一个数。',
    parameters: {
      type: 'object',
      properties: {
        packageId: { type: 'string' },
        traceLimit: { type: 'number', description: '看最近多少条轨迹（默认 200）' },
      },
      required: ['packageId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          agents: { type: 'array' },
          usage: { type: 'object' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value || {};
        if (!v.ok) return text(`读取失败：${v.message || '未知原因'}`);
        if (!v.agents.length) return text('这个资产包还没有声明任何 Agent。');
        const lines = ['Agent 花名册（声明）与实际调用（轨迹）：'];
        for (const a of v.agents) {
          const use = (v.usage.byTool || {})[a.id] || {};
          const calls = Object.values(use).reduce((n, x) => n + x.ok + x.fail, 0);
          lines.push(`\n${a.name}（${a.id}）· ${a.status || 'draft'}`);
          if (a.model) lines.push(`  模型：${a.model}`);
          if (a.usesObjects && a.usesObjects.length) lines.push(`  依赖对象：${a.usesObjects.join(', ')}`);
          if (a.tools && a.tools.length) lines.push(`  工具：${a.tools.join(', ')}`);
          if (a.actions && a.actions.length) lines.push(`  动作：${a.actions.join(', ')}`);
          if (a.evalTarget) lines.push(`  评测口径：${a.evalTarget}`);
          const metric = (v.metrics || []).find((m) => m.id === a.id) || {};
          lines.push(
            `  实际调用：${calls ? Object.entries(use).map(([t, s]) => t + ' ' + (s.ok + s.fail) + ' 次').join('；') : '轨迹里没有这个 Agent 的调用'}`
          );
          if (typeof metric.successRate === 'number') lines.push(`  成功率：${metric.successRate}%（${metric.calls} 次，失败 ${metric.fails}）`);
          if (metric.unusedDeclaredTools && metric.unusedDeclaredTools.length) {
            lines.push(`  声明了但没用过：${metric.unusedDeclaredTools.join(', ')}`);
          }
        }
        if (v.usage.unattributed) {
          lines.push(`\n轨迹中无法归属到声明 Agent 的调用：${v.usage.unattributed} 次`);
        }
        return text(lines.join('\n'));
      },
    },
    execute: async (args) => {
      const { entry } = await store.get(args.packageId);
      if (!entry || !entry.ir) return { ok: false, message: `资产包不存在：${args.packageId}` };
      const agents = entry.ir.agents || [];
      const declared = new Set(agents.map((a) => a.id));

      const limit = Math.max(1, Math.min(Number.isFinite(args.traceLimit) ? args.traceLimit : 200, 500));
      const entries = await trace.list(limit);
      const byTool = {};
      let unattributed = 0;
      for (const item of entries) {
        const who = item.agent && declared.has(item.agent) ? item.agent : null;
        if (!who) {
          if (item.agent) unattributed += 1;
          continue;
        }
        byTool[who] = byTool[who] || {};
        byTool[who][item.tool] = byTool[who][item.tool] || { ok: 0, fail: 0 };
        if (item.ok) byTool[who][item.tool].ok += 1;
        else byTool[who][item.tool].fail += 1;
      }
      return {
        ok: true,
        agents,
        metrics: agents.map((agent) => {
          const per = byTool[agent.id] || {};
          const tools = Object.keys(per).map((tool) => ({
            tool,
            ok: per[tool].ok,
            fail: per[tool].fail,
            successRate: per[tool].ok + per[tool].fail ? Math.round((per[tool].ok / (per[tool].ok + per[tool].fail)) * 100) : null,
          }));
          const calls = tools.reduce((n, t) => n + t.ok + t.fail, 0);
          const fails = tools.reduce((n, t) => n + t.fail, 0);
          return {
            id: agent.id,
            name: agent.name,
            calls,
            fails,
            successRate: calls ? Math.round(((calls - fails) / calls) * 100) : null,
            tools: tools.sort((a, b) => b.ok + b.fail - (a.ok + a.fail)),
            declaredTools: (agent.tools || []).length,
            unusedDeclaredTools: (agent.tools || []).filter((name) => !per[name]),
          };
        }),
        usage: { byTool, unattributed, scanned: entries.length, traceFile: trace.file },
      };
    },
  });

  /* ------------------------------------------------------------------ *
   * ontology_eval_run / ontology_eval_compare
   * ------------------------------------------------------------------ */
  register({
    name: 'ontology_eval_run',
    description:
      '跑一次规则评测并把这次运行记录下来：跑在哪个资产包、哪套规则、哪份数据上，违规分布是什么。记录下来的运行才能和另一次对比——条件不同的结果不可比。可传 records 用候选数据试规则。',
    parameters: {
      type: 'object',
      properties: {
        packageId: { type: 'string' },
        records: { type: 'object', description: '可选：用这份候选事实数据（形如 {objects:{...}}），默认用资产包自带的' },
      },
      required: ['packageId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          run: { type: 'object' },
          runs: { type: 'number' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value || {};
        if (!v.ok) return text(`评测失败：${v.message || '未知原因'}`);
        const r = v.run;
        const lines = [
          `评测 ${r.id}：${r.packageId} v${r.packageVersion}`,
          `  ${r.rows} 行数据，${r.evaluated} 条规则生效，${r.violations} 处违规（涉及 ${r.violatingRules} 条规则）`,
        ];
        for (const rule of r.byRule.filter((x) => x.violations > 0)) {
          lines.push(`  ${rule.rule}（${rule.object}）：${rule.violations} 处`);
        }
        if (r.unresolved) lines.push(`  ${r.unresolved} 条规则无法解析归属`);
        lines.push(`条件指纹：规则 ${r.conditions.rules}，数据 ${r.conditions.data}`);
        lines.push(`已记录，共 ${v.runs} 次运行`);
        return text(lines.join('\n'));
      },
    },
    execute: async (args) => {
      const { entry } = await store.get(args.packageId);
      if (!entry || !entry.ir) return { ok: false, message: `资产包不存在：${args.packageId}` };

      let records = args.records;
      let recordsFile = null;
      if (!records) {
        const loaded = await loadRecords(entry.file);
        if (!loaded.records) return { ok: false, message: loaded.problems.join('；') || '没有事实数据' };
        records = loaded.records;
        recordsFile = loaded.file;
      }

      const run = runEvaluation(entry.ir, records, { packageFile: entry.path, recordsFile });
      await evals.append(run);
      const all = await evals.list(200);
      return { ok: true, run, runs: all.length };
    },
  });

  register({
    name: 'ontology_eval_compare',
    description:
      '对比两次规则评测。默认比最近两次。只有条件受控时才允许比较：规则和数据都变了会拒绝，并说明该怎么固定其中一边。',
    parameters: {
      type: 'object',
      properties: {
        runA: { type: 'string', description: '可选：基准运行 id（默认倒数第二次）' },
        runB: { type: 'string', description: '可选：目标运行 id（默认最后一次）' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          comparison: { type: 'object' },
          runs: { type: 'array' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value || {};
        if (!v.ok) return text(`对比失败：${v.message || '未知原因'}`);
        const c = v.comparison;
        if (!c.comparable) {
          return text(
            `不可比：${c.reason}\n已有运行：` +
              (v.runs || []).map((r) => `${r.id}（v${r.packageVersion}，${r.violations} 处违规）`).join('；')
          );
        }
        const d = c.delta;
        const lines = [
          `${c.from.id} → ${c.to.id}（${c.varies}）`,
          `  违规 ${d.violations >= 0 ? '+' : ''}${d.violations}，涉及规则 ${d.violatingRules >= 0 ? '+' : ''}${d.violatingRules}，无法解析 ${d.unresolved >= 0 ? '+' : ''}${d.unresolved}`,
        ];
        for (const rule of c.perRule.filter((r) => r.delta !== 0 || r.status !== 'common')) {
          const tag = rule.status === 'added' ? '新增规则' : rule.status === 'removed' ? '规则已删' : `${rule.before} → ${rule.after}`;
          lines.push(`  ${rule.rule}：${tag}（${rule.delta >= 0 ? '+' : ''}${rule.delta}）`);
        }
        return text(lines.join('\n'));
      },
    },
    execute: async (args) => {
      const all = await evals.list(200);
      const runs = all.map((r) => ({ id: r.id, ts: r.ts, packageVersion: r.packageVersion, violations: r.violations }));
      if (all.length < 2) {
        return { ok: false, runs, message: `至少需要两次运行才能对比，当前只有 ${all.length} 次` };
      }
      const pick = (id, fallback) => (id ? all.find((r) => r.id === id) : all[fallback]);
      // evals.list returns newest first
      const b = pick(args.runB, 0);
      const a = pick(args.runA, 1);
      if (!a || !b) {
        return { ok: false, runs, message: `找不到指定的运行：${!a ? 'runA' : 'runB'}` };
      }
      return { ok: true, comparison: compareRuns(a, b), runs };
    },
  });

  /* ------------------------------------------------------------------ *
   * ontology_harness_check  (read — is this ontology ready to be a base?)
   * ------------------------------------------------------------------ */
  register({
    name: 'ontology_harness_check',
    description:
      '体检：这份本体作为 Agent 的底座还缺什么——结构（主键/关系/属性）、规则、可执行动作、审批护栏、事实数据、Agent 花名册六个方面逐项检查，缺口直接说要怎么补。不评分、不猜，只陈述文件里的事实。思路来自 Harness² 的组件分类。',
    parameters: {
      type: 'object',
      properties: { packageId: { type: 'string' } },
      required: ['packageId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          report: { type: 'object' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value || {};
        if (!v.ok) return text(`体检失败：${v.message || '未知原因'}`);
        const r = v.report;
        const head =
          r.verdict === 'ready'
            ? `✓ ${r.packageId} 六个方面都齐了（${r.readyAreas}/${r.totalAreas}）`
            : `△ ${r.packageId}：${r.readyAreas}/${r.totalAreas} 个方面就绪，${r.gaps.length} 处缺口`;
        const lines = [head];
        for (const g of r.gaps) {
          lines.push(`- [${g.area}] ${g.title}`);
          if (g.how) lines.push(`    怎么补：${g.how}`);
        }
        for (const n of r.notes) lines.push(`注意：${n}`);
        return text(lines.join('\n'));
      },
    },
    execute: async (args) => {
      const { entry } = await store.get(args.packageId);
      if (!entry || !entry.ir) return { ok: false, message: `资产包不存在：${args.packageId}` };
      const loaded = await loadRecords(entry.file);
      return { ok: true, report: harnessCheck(entry.ir, { records: loaded.records || null }) };
    },
  });

  /* ------------------------------------------------------------------ *
   * ontology_diff / ontology_upgrade
   * ------------------------------------------------------------------ */
  register({
    name: 'ontology_diff',
    description:
      '对比两个资产包（同一份本体的两个版本，或任意两个包）：按对象/关系/规则/动作/策略/Agent 分组列出新增、删除、变更。升级前先跑它，比只看版本号有用得多。',
    parameters: {
      type: 'object',
      properties: {
        packageId: { type: 'string', description: '对比的基准包' },
        againstPackageId: { type: 'string', description: '要对比的目标包' },
        againstSource: { type: 'string', description: '目标从哪里取：installed（默认）| catalog —— 同名包比版本时用 catalog' },
      },
      required: ['packageId', 'againstPackageId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, diff: { type: 'object' }, summary: { type: 'string' }, message: { type: 'string' } },
      },
      render: (_args, value) => {
        const v = value || {};
        if (!v.ok) return text(`对比失败：${v.message || '未知原因'}`);
        const d = v.diff;
        const lines = [`${d.from.id}：v${d.from.version} → v${d.to.version}（${d.summary.added} 增 / ${d.summary.removed} 删 / ${d.summary.changed} 改）`];
        for (const section of d.sections) {
          const bits = [];
          if (section.added.length) bits.push('新增 ' + section.added.join(', '));
          if (section.removed.length) bits.push('删除 ' + section.removed.join(', '));
          for (const change of section.changed) {
            bits.push(change.id + '：' + change.changes.map((c) => (c.field === 'property' ? (c.op === 'added' ? '+' : '-') + c.name : c.field)).join(', '));
          }
          if (bits.length) lines.push(`${section.collection}：${bits.join('；')}`);
        }
        if (d.identical) lines.push('两个版本完全一致');
        return text(lines.join('\n'));
      },
    },
    execute: async (args) => {
      const from = await store.get(args.packageId);
      if (!from.entry || !from.entry.ir) return { ok: false, message: `基准包不存在：${args.packageId}` };

      // Same-id packages exist in both places when a newer version is on offer,
      // so the source has to be explicit.
      let target = null;
      if (args.againstSource !== 'catalog') {
        const to = await store.get(args.againstPackageId);
        target = to.entry && to.entry.ir ? to.entry.ir : null;
      }
      if (!target) {
        const state = await catalogState({ catalogDir, assetsDir: store.dir });
        const hit = state.available.find((e) => e.ir && e.ir.id === args.againstPackageId);
        target = hit ? hit.ir : null;
      }
      if (!target) return { ok: false, message: `目标包不存在：${args.againstPackageId}` };

      const diff = diffPackages(from.entry.ir, target);
      return { ok: true, diff, summary: describeDiff(diff) };
    },
  });

  registerWrite({
    name: 'ontology_upgrade',
    description:
      '用资产市场里的同名包升级已安装的包：校验新版本后原位覆盖，并把 op=upgrade 记进变更历史。市场里没有同 id 的其它版本时拒绝。',
    parameters: {
      type: 'object',
      properties: { packageId: { type: 'string' } },
      required: ['packageId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          packageId: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          file: { type: 'string' },
          etag: { type: 'string' },
          summary: { type: 'string' },
          problems: { type: 'array' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value || {};
        if (v.ok) {
          const head = v.file ? '已升级' : '可升级（dryRun 未写盘）';
          return text(`${head} ${v.packageId}：v${v.from} → v${v.to}（${v.summary}）${v.file ? ' → ' + v.file : ''}`);
        }
        return text(`未升级：${v.message || '未知原因'}`);
      },
    },
    execute: async (args, exec) => {
      const installed = await store.get(args.packageId);
      if (!installed.entry || !installed.entry.ir) {
        return { ok: false, packageId: args.packageId, message: `没有安装这个包：${args.packageId}` };
      }
      const state = await catalogState({ catalogDir, assetsDir: store.dir });
      const candidate = state.available.find(
        (e) => e.ir && e.ir.id === args.packageId && e.ir.version !== installed.entry.ir.version
      );
      if (!candidate) {
        return {
          ok: false,
          packageId: args.packageId,
          message: `资产市场里没有 ${args.packageId} 的其它版本（当前 v${installed.entry.ir.version}）`,
        };
      }
      if (!candidate.ok) {
        return { ok: false, packageId: args.packageId, problems: candidate.problems, message: '新版本未通过校验，拒绝升级' };
      }

      const gate = await gateWrite(exec, {
        toolName: 'ontology_upgrade',
        destructive: true,
        dryRun: args.dryRun === true,
        reason: `升级 ${args.packageId}：v${installed.entry.ir.version} → v${candidate.ir.version}`,
      });
      if (!gate.allowed) {
        return { ok: false, packageId: args.packageId, approval: gate.outcome, message: gate.message };
      }

      const diff = diffPackages(installed.entry.ir, candidate.ir);
      if (diff.identical) {
        return { ok: false, packageId: args.packageId, message: '新版本与已安装版本内容一致，无需升级' };
      }
      if (args.dryRun === true) {
        return {
          ok: true,
          packageId: candidate.ir.id,
          from: installed.entry.ir.version,
          to: candidate.ir.version,
          etag: installed.entry.etag,
          summary: describeDiff(diff),
          message: 'dryRun：校验通过，未写盘',
        };
      }
      const saved = await store.save(installed.entry.file, candidate.ir, { ifEtag: args.ifEtag || installed.entry.etag });
      if (saved.conflict) {
        return {
          ok: false,
          packageId: args.packageId,
          conflict: true,
          etag: saved.etag,
          problems: saved.problems,
          message: '资产已被修改，请重新读取后再升级',
        };
      }
      await noteHistory({
        ts: Date.now(),
        packageId: candidate.ir.id,
        version: candidate.ir.version,
        op: 'upgrade',
        target: candidate.ir.id,
        summary: `升级 v${installed.entry.ir.version} → v${candidate.ir.version}（${describeDiff(diff)}）`,
        etag: saved.etag,
      });
      return {
        ok: saved.ok,
        packageId: candidate.ir.id,
        from: installed.entry.ir.version,
        to: candidate.ir.version,
        file: saved.file,
        etag: saved.etag,
        summary: describeDiff(diff),
        problems: saved.problems,
      };
    },
  });

  /* ------------------------------------------------------------------ *
   * ontology_draft_from_payload  (read — reverse model from a JSON sample)
   * ------------------------------------------------------------------ */
  register({
    name: 'ontology_draft_from_payload',
    description:
      '反向建模（样例报文）：给一段真实的接口返回/消息样例，推断出本体对象草稿——按值判类型、键名归一、推断主键、从 *Id 字段推关系。只生成不写盘，确认后用 ontology_upsert_object 落库。',
    parameters: {
      type: 'object',
      properties: {
        packageId: { type: 'string' },
        sample: { type: 'object', description: '一段代表性的 JSON 对象或对象数组' },
        objectId: { type: 'string', description: '建议的对象 id（PascalCase 或 kebab），默认 SampleObject' },
        name: { type: 'string', description: '对象中文名' },
      },
      required: ['packageId', 'sample'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          object: { type: 'object' },
          links: { type: 'array' },
          nested: { type: 'array' },
          problems: { type: 'array' },
          valid: { type: 'boolean' },
          validationProblems: { type: 'array' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value || {};
        if (!v.ok) return text(`生成失败：${v.message || '未知原因'}`);
        const lines = [
          `草稿对象 ${v.object.id}（${v.object.name}）：${v.object.properties.length} 个属性，主键 ${(v.object.keys || []).join('+') || '未识别'}`,
          ...v.object.properties.map((p) => `  - ${p.name}（${p.label}）: ${p.type}`),
          v.links && v.links.length ? `关系建议：${v.links.map((l) => l.id + ' → ' + l.target).join(', ')}` : '关系建议：无',
          v.nested && v.nested.length ? `抽出的嵌套对象：${v.nested.map((n) => n.id).join(', ')}` : '',
          v.valid ? '预校验：并入后整包仍然合法' : '预校验：并入后不合法',
          ...(v.problems || []).map((p) => `注意 [${p.code}] ${p.message}`),
        ];
        return text(lines.filter(Boolean).join('\n'));
      },
    },
    execute: async (args) => {
      const { entry } = await store.get(args.packageId);
      if (!entry || !entry.ir) return { ok: false, message: `资产包不存在：${args.packageId}` };

      const draft = draftFromSample(args.sample, {
        objects: entry.ir.objects,
        objectId: args.objectId,
        name: args.name,
      });
      if (!draft.object) {
        return { ok: false, problems: draft.problems, message: (draft.problems[0] || {}).message || '无法生成' };
      }
      const check = validateDraft(entry.ir, draft);
      const validation = validateIr(JSON.parse(JSON.stringify(check.candidate)));
      return {
        ok: true,
        object: draft.object,
        links: draft.links,
        nested: draft.nested,
        problems: draft.problems,
        valid: validation.ok,
        validationProblems: validation.problems,
      };
    },
  });

  /* ------------------------------------------------------------------ *
   * ontology_regression_plan  (read — what to re-verify after a change)
   * ------------------------------------------------------------------ */
  register({
    name: 'ontology_regression_plan',
    description:
      '改动某个对象后，生成需要重新验证的具体清单：哪些规则要在数据上重跑、哪些动作要重跑、哪些关系要复查、哪些 Agent 受影响、哪些产物要重新生成。比笼统一句「记得回归」有用。',
    parameters: {
      type: 'object',
      properties: {
        packageId: { type: 'string' },
        objectId: { type: 'string' },
        change: { type: 'string', description: '可选：这次改了什么，会写进清单标题' },
      },
      required: ['packageId', 'objectId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, plan: { type: 'object' }, message: { type: 'string' } },
      },
      render: (_args, value) => {
        const v = value || {};
        if (!v.ok) return text(`生成失败：${v.message || '未知原因'}`);
        const plan = v.plan;
        const lines = [
          `${plan.objectId} 的回归清单（${plan.items.length} 项）${plan.change ? '：' + plan.change : ''}`,
        ];
        for (const item of plan.items) {
          lines.push(`- [${item.kind}] ${item.title}`);
          if (item.detail) lines.push(`    ${item.detail}`);
          if (item.how && item.how !== '—') lines.push(`    怎么验：${item.how}`);
        }
        return text(lines.join('\n'));
      },
    },
    execute: async (args) => {
      const { entry } = await store.get(args.packageId);
      if (!entry || !entry.ir) return { ok: false, message: `资产包不存在：${args.packageId}` };
      const plan = buildRegressionPlan(entry.ir, args.objectId, { change: args.change });
      if (!plan) {
        return {
          ok: false,
          message: `对象不存在：${args.objectId}。可用对象：${(entry.ir.objects || []).map((o) => o.id).join(', ')}`,
        };
      }
      return { ok: true, plan };
    },
  });

  /* ------------------------------------------------------------------ *
   * ontology_upsert_object  (write)
   * ------------------------------------------------------------------ */
  registerWrite({
    name: 'ontology_upsert_object',
    description:
      '新增或替换本体包里的一个对象定义。写入前会校验整个包：结构或跨引用不成立就直接拒绝，并在磁盘上保持原样。传 dryRun 只预览不落盘。改完建议再跑 ontology_validate 与 ontology_impact。',
    parameters: {
      type: 'object',
      properties: {
        packageId: { type: 'string', description: '资产包 id' },
        object: {
          type: 'object',
          description: '完整的对象定义，需包含 id、name、properties；可含 description、keys',
        },
        dryRun: { type: 'boolean', description: '只校验不写盘' },
      },
      required: ['packageId', 'object'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          objectId: { type: 'string' },
          version: { type: 'string' },
          file: { type: 'string' },
          problems: { type: 'array' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value || {};
        if (v.ok) {
          return text(
            `${v.action === 'created' ? '已新增' : '已更新'}对象 ${v.objectId}（${v.packageId || '—'} v${v.version}）→ ${v.file || 'dryRun 未写盘'}`
          );
        }
        return text(
          lines([
            `未写入：${v.message || '校验未通过'}（磁盘保持原样）`,
            ...(v.problems || []).map((p) => `  [${p.code}] ${p.path} — ${p.message}`),
          ])
        );
      },
    },
    execute: async (args, exec) => {
      const gate = await gateWrite(exec, {
        toolName: 'ontology_upsert_object',
        destructive: false,
        dryRun: args.dryRun === true,
        reason: `新增或替换对象 ${args.object && args.object.id}（${args.packageId}）`,
      });
      if (!gate.allowed) {
        return { ok: false, approval: gate.outcome, message: gate.message };
      }
      const { entry } = await store.get(args.packageId);
      if (!entry || !entry.ir) {
        return { ok: false, message: `资产包不存在：${args.packageId}` };
      }
      if (args.object === null || typeof args.object !== 'object' || Array.isArray(args.object)) {
        return { ok: false, message: 'object 必须是一个对象定义' };
      }
      const ir = JSON.parse(JSON.stringify(entry.ir));
      const objects = Array.isArray(ir.objects) ? ir.objects : (ir.objects = []);
      const index = objects.findIndex((o) => o.id === args.object.id);
      const action = index >= 0 ? 'updated' : 'created';
      if (index >= 0) objects[index] = args.object;
      else objects.push(args.object);

      const check = validateIr(ir);
      if (!check.ok) {
        return {
          ok: false,
          action,
          objectId: args.object.id,
          version: ir.version,
          problems: check.problems,
          message: '写入会让本体包失效',
        };
      }
      if (args.dryRun) {
        return { ok: true, action, objectId: args.object.id, packageId: ir.id, version: ir.version, etag: entry.etag, message: 'dryRun：校验通过，未写盘' };
      }

      // Read-modify-write under the file lock: concurrent adds must queue, not
      // fight over compare-and-swap. An explicit ifEtag still takes precedence.
      const applied = await store.update(
        entry.file,
        (draft) => {
          const list = Array.isArray(draft.objects) ? draft.objects : (draft.objects = []);
          const at = list.findIndex((o) => o.id === args.object.id);
          if (at >= 0) list[at] = args.object;
          else list.push(args.object);
          return { ok: true, action };
        },
        { ifEtag: args.ifEtag }
      );
      if (applied.conflict) {
        return {
          ok: false,
          conflict: true,
          etag: applied.etag,
          problems: applied.problems,
          message: '资产已被修改，请重新读取（ontology_get）后再写入',
        };
      }
      if (!applied.ok) {
        return {
          ok: false,
          action,
          objectId: args.object.id,
          version: ir.version,
          problems: applied.problems,
          message: '写入会让本体包失效',
        };
      }
      const saved = applied;
      await noteHistory({ ts: Date.now(), packageId: ir.id, version: ir.version, op: 'upsert_object', target: args.object.id, summary: (action === 'created' ? '新增对象 ' : '更新对象 ') + args.object.id, etag: saved.etag });
      return {
        ok: saved.ok,
        action,
        objectId: args.object.id,
        packageId: ir.id,
        version: ir.version,
        file: saved.file, etag: saved.etag,
        problems: saved.problems,
      };
    },
  });

  /* ------------------------------------------------------------------ *
   * ontology_publish  (write)
   * ------------------------------------------------------------------ */
  registerWrite({
    name: 'ontology_publish',
    description:
      '发布一个本体包：校验必须全部通过，然后按 bump 递增版本号并把状态置为 published。校验失败则拒绝发布，磁盘保持原样。',
    parameters: {
      type: 'object',
      properties: {
        packageId: { type: 'string' },
        bump: { type: 'string', description: 'patch（默认）| minor | major' },
      },
      required: ['packageId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          from: { type: 'string' },
          to: { type: 'string' },
          file: { type: 'string' },
          problems: { type: 'array' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value || {};
        if (v.ok) return text(`已发布：${v.from} → ${v.to}（${v.file}）`);
        return text(
          lines([
            `未发布：${v.message || '校验未通过'}`,
            ...(v.problems || []).map((p) => `  [${p.code}] ${p.path} — ${p.message}`),
          ])
        );
      },
    },
    execute: async (args, exec) => {
      const gate = await gateWrite(exec, {
        toolName: 'ontology_publish',
        destructive: true,
        dryRun: args.dryRun === true,
        reason: `发布本体包 ${args.packageId}（${args.bump || 'patch'} 版本递增）`,
      });
      if (!gate.allowed) {
        return { ok: false, approval: gate.outcome, message: gate.message };
      }
      const { entry } = await store.get(args.packageId);
      if (!entry || !entry.ir) {
        return { ok: false, message: `资产包不存在：${args.packageId}` };
      }
      const check = validateIr(entry.ir);
      if (!check.ok) {
        return { ok: false, from: entry.ir.version, problems: check.problems, message: '本体包未通过校验' };
      }
      const ir = JSON.parse(JSON.stringify(entry.ir));
      const from = ir.version;
      const to = bumpVersion(from, args.bump);
      ir.version = to;
      ir.status = 'published';
      const saved = await store.save(entry.file, ir, { ifEtag: args.ifEtag || entry.etag });
      if (saved.conflict) {
        return {
          ok: false,
          conflict: true,
          etag: saved.etag,
          problems: saved.problems,
          message: '资产已被修改，请重新读取（ontology_get）后再写入',
        };
      }
      await noteHistory({ ts: Date.now(), packageId: ir.id, version: to, op: 'publish', target: ir.id, summary: '发布 ' + from + ' → ' + to + (args.bump && args.bump !== 'patch' ? '（' + args.bump + '）' : ''), etag: saved.etag });
      return { ok: saved.ok, from, to, file: saved.file, etag: saved.etag, problems: saved.problems };
    },
  });

  /* ------------------------------------------------------------------ *
   * ontology_upsert_link  (write)
   * ------------------------------------------------------------------ */
  registerWrite({
    name: 'ontology_upsert_link',
    description:
      '新增或替换一条对象关系。两端对象必须已存在，写入前校验整包；不成立就拒绝且磁盘保持原样。传 dryRun 只预览。',
    parameters: {
      type: 'object',
      properties: {
        packageId: { type: 'string' },
        link: {
          type: 'object',
          description: '关系定义，需含 id、source、target、type；可含 cardinality',
        },
        dryRun: { type: 'boolean' },
      },
      required: ['packageId', 'link'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          linkId: { type: 'string' },
          version: { type: 'string' },
          file: { type: 'string' },
          problems: { type: 'array' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value || {};
        if (v.ok) return text(`${v.action === 'created' ? '已新增' : '已更新'}关系 ${v.linkId}（v${v.version}）→ ${v.file}`);
        return text(
          lines([
            `未写入：${v.message || '校验未通过'}（磁盘保持原样）`,
            ...(v.problems || []).map((p) => `  [${p.code}] ${p.path} — ${p.message}`),
          ])
        );
      },
    },
    execute: async (args, exec) => {
      const gate = await gateWrite(exec, {
        toolName: 'ontology_upsert_link',
        destructive: false,
        dryRun: args.dryRun === true,
        reason: `新增或替换关系 ${args.link && args.link.id}（${args.packageId}）`,
      });
      if (!gate.allowed) {
        return { ok: false, approval: gate.outcome, message: gate.message };
      }
      const { entry } = await store.get(args.packageId);
      if (!entry || !entry.ir) return { ok: false, message: `资产包不存在：${args.packageId}` };
      if (args.link === null || typeof args.link !== 'object' || Array.isArray(args.link)) {
        return { ok: false, message: 'link 必须是一个关系定义' };
      }
      const ir = JSON.parse(JSON.stringify(entry.ir));
      const links = Array.isArray(ir.links) ? ir.links : (ir.links = []);
      const index = links.findIndex((l) => l.id === args.link.id);
      const action = index >= 0 ? 'updated' : 'created';
      if (index >= 0) links[index] = args.link;
      else links.push(args.link);

      const check = validateIr(ir);
      if (!check.ok) {
        return { ok: false, action, linkId: args.link.id, version: ir.version, problems: check.problems, message: '写入会让本体包失效' };
      }
      if (args.dryRun) return { ok: true, action, linkId: args.link.id, version: ir.version, etag: entry.etag, message: 'dryRun：校验通过，未写盘' };
      const saved = await store.save(entry.file, ir, { ifEtag: args.ifEtag || entry.etag });
      if (saved.conflict) {
        return {
          ok: false,
          conflict: true,
          etag: saved.etag,
          problems: saved.problems,
          message: '资产已被修改，请重新读取（ontology_get）后再写入',
        };
      }
      await noteHistory({ ts: Date.now(), packageId: ir.id, version: ir.version, op: 'upsert_link', target: args.link.id, summary: (action === 'created' ? '新增关系 ' : '更新关系 ') + args.link.id, etag: saved.etag });
      return { ok: saved.ok, action, linkId: args.link.id, version: ir.version, file: saved.file, etag: saved.etag, problems: saved.problems };
    },
  });

  /* ------------------------------------------------------------------ *
   * ontology_delete_link  (write)
   * ------------------------------------------------------------------ */
  registerWrite({
    name: 'ontology_delete_link',
    description: '删除一条对象关系。关系删掉不会波及对象与动作，仍会校验整包后写入。',
    parameters: {
      type: 'object',
      properties: {
        packageId: { type: 'string' },
        linkId: { type: 'string' },
        dryRun: { type: 'boolean' },
      },
      required: ['packageId', 'linkId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          linkId: { type: 'string' },
          file: { type: 'string' },
          problems: { type: 'array' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value || {};
        if (v.ok) return text(`已删除关系 ${v.linkId} → ${v.file || '（dryRun 未写盘）'}`);
        return text(`未删除：${v.message || '校验未通过'}`);
      },
    },
    execute: async (args, exec) => {
      const gate = await gateWrite(exec, {
        toolName: 'ontology_delete_link',
        destructive: true,
        dryRun: args.dryRun === true,
        reason: `删除关系 ${args.linkId}（${args.packageId}）`,
      });
      if (!gate.allowed) {
        return { ok: false, approval: gate.outcome, message: gate.message };
      }
      const { entry } = await store.get(args.packageId);
      if (!entry || !entry.ir) return { ok: false, message: `资产包不存在：${args.packageId}` };
      const ir = JSON.parse(JSON.stringify(entry.ir));
      const links = Array.isArray(ir.links) ? ir.links : [];
      if (!links.some((l) => l.id === args.linkId)) {
        return { ok: false, message: `关系不存在：${args.linkId}。可用关系：${links.map((l) => l.id).join(', ') || '无'}` };
      }
      ir.links = links.filter((l) => l.id !== args.linkId);
      const check = validateIr(ir);
      if (!check.ok) return { ok: false, linkId: args.linkId, problems: check.problems, message: '删除会让本体包失效' };
      if (args.dryRun) return { ok: true, linkId: args.linkId, message: 'dryRun：未写盘' };
      const saved = await store.save(entry.file, ir, { ifEtag: args.ifEtag || entry.etag });
      if (saved.conflict) {
        return {
          ok: false,
          conflict: true,
          etag: saved.etag,
          problems: saved.problems,
          message: '资产已被修改，请重新读取（ontology_get）后再写入',
        };
      }
      await noteHistory({ ts: Date.now(), packageId: ir.id, version: ir.version, op: 'delete_link', target: args.linkId, summary: '删除关系 ' + args.linkId, etag: saved.etag });
      return { ok: saved.ok, linkId: args.linkId, file: saved.file, etag: saved.etag, problems: saved.problems };
    },
  });

  /* ------------------------------------------------------------------ *
   * ontology_delete_object  (write)
   * ------------------------------------------------------------------ */
  registerWrite({
    name: 'ontology_delete_object',
    description:
      '删除一个对象。它若被关系、动作或策略引用，默认拒绝并列出全部依赖；传 cascade 才会连带清理：删除相关关系、把它从动作的 writes 里摘掉（动作不再写任何对象则一并删除）、并清理指向被删动作的策略。删除前校验整包，不通过就拒绝且磁盘保持原样。',
    parameters: {
      type: 'object',
      properties: {
        packageId: { type: 'string' },
        objectId: { type: 'string' },
        cascade: { type: 'boolean', description: 'true 时连带清理依赖，默认 false 只做检查' },
        dryRun: { type: 'boolean' },
      },
      required: ['packageId', 'objectId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          blocked: { type: 'boolean' },
          objectId: { type: 'string' },
          links: { type: 'array' },
          actions: { type: 'array' },
          policies: { type: 'array' },
          version: { type: 'string' },
          file: { type: 'string' },
          problems: { type: 'array' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value || {};
        if (v.blocked) {
          return text(
            lines([
              `拒绝删除 ${v.objectId}：还有 ${(v.links || []).length} 条关系、${(v.actions || []).length} 个动作、${(v.policies || []).length} 条策略引用它`,
              ...(v.links || []).map((l) => `  关系 ${l.id}`),
              ...(v.actions || []).map((a) => `  动作 ${a.id}`),
              ...(v.policies || []).map((p) => `  策略 ${p.id}`),
              '确认要连带清理请传 cascade: true',
            ])
          );
        }
        if (v.ok) {
          return text(
            `已删除 ${v.objectId}${v.cascaded ? '，连带清理 ' + v.cascaded.links + ' 条关系 / ' + v.cascaded.actions + ' 个动作 / ' + v.cascaded.policies + ' 条策略' : ''} → ${v.file || '（dryRun 未写盘）'}`
          );
        }
        return text(
          lines([
            `未删除：${v.message || '校验未通过'}`,
            ...(v.problems || []).map((p) => `  [${p.code}] ${p.path} — ${p.message}`),
          ])
        );
      },
    },
    execute: async (args, exec) => {
      const gate = await gateWrite(exec, {
        toolName: 'ontology_delete_object',
        destructive: true,
        dryRun: args.dryRun === true,
        reason: `删除对象 ${args.objectId}（${args.packageId}${args.cascade ? '，级联清理依赖' : ''}）`,
      });
      if (!gate.allowed) {
        return { ok: false, approval: gate.outcome, message: gate.message };
      }
      const { entry } = await store.get(args.packageId);
      if (!entry || !entry.ir) return { ok: false, message: `资产包不存在：${args.packageId}` };
      const ir = JSON.parse(JSON.stringify(entry.ir));
      const objects = Array.isArray(ir.objects) ? ir.objects : [];
      if (!objects.some((o) => o.id === args.objectId)) {
        return {
          ok: false,
          objectId: args.objectId,
          message: `对象不存在：${args.objectId}。可用对象：${objects.map((o) => o.id).join(', ')}`,
        };
      }

      const links = (ir.links || []).filter((l) => l.source === args.objectId || l.target === args.objectId);
      const actions = (ir.actions || []).filter((a) => (a.writes || []).includes(args.objectId));
      const actionIds = actions.map((a) => a.id);
      const policies = (ir.policies || []).filter((p) => (p.appliesTo || []).some((a) => actionIds.includes(a)));

      if ((links.length || actions.length) && !args.cascade) {
        return {
          ok: false,
          blocked: true,
          objectId: args.objectId,
          links: links.map((l) => ({ id: l.id, source: l.source, target: l.target })),
          actions: actions.map((a) => ({ id: a.id })),
          policies: policies.map((p) => ({ id: p.id })),
          message: '对象仍被引用，需 cascade 才能删除',
        };
      }

      ir.objects = objects.filter((o) => o.id !== args.objectId);
      ir.links = (ir.links || []).filter((l) => l.source !== args.objectId && l.target !== args.objectId);

      const droppedActions = [];
      ir.actions = (ir.actions || [])
        .map((a) => {
          const writesObject = (a.writes || []).includes(args.objectId);
          if (!writesObject) return a;
          const writes = a.writes.filter((w) => w !== args.objectId);
          // An effect that targets the deleted object can no longer be applied;
          // drop those entries (multi-effect actions may keep the rest).
          let effect = a.effect;
          if (Array.isArray(a.effect)) {
            const kept = a.effect.filter((e) => e && e.object !== args.objectId);
            effect = kept.length ? kept : undefined;
          } else if (a.effect && a.effect.object === args.objectId) {
            effect = undefined;
          }
          if (writes.length === 0) {
            droppedActions.push(a.id);
            return null;
          }
          const next = Object.assign({}, a, { writes });
          if (effect === undefined) delete next.effect;
          else next.effect = effect;
          return next;
        })
        .filter(Boolean);

      const trimmedPolicies = [];
      ir.policies = (ir.policies || [])
        .map((p) => {
          if (!Array.isArray(p.appliesTo)) return p;
          const appliesTo = p.appliesTo.filter((a) => droppedActions.indexOf(a) < 0);
          if (appliesTo.length === p.appliesTo.length) return p;
          trimmedPolicies.push(p.id);
          return Object.assign({}, p, { appliesTo });
        })
        .filter((p) => !Array.isArray(p.appliesTo) || p.appliesTo.length > 0);

      // Agents reference objects and actions too; leaving them dangling would
      // make the package invalid, so the cascade trims those references as well.
      const trimmedAgents = [];
      if (Array.isArray(ir.agents)) {
        ir.agents = ir.agents.map((agent) => {
          const usesObjects = (agent.usesObjects || []).filter((id) => id !== args.objectId);
          const actions = (agent.actions || []).filter((id) => droppedActions.indexOf(id) < 0);
          const objectsChanged = usesObjects.length !== (agent.usesObjects || []).length;
          const actionsChanged = actions.length !== (agent.actions || []).length;
          if (!objectsChanged && !actionsChanged) return agent;
          trimmedAgents.push(agent.id);
          return Object.assign({}, agent, { usesObjects, actions });
        });
      }

      const check = validateIr(ir);
      if (!check.ok) {
        return { ok: false, objectId: args.objectId, version: ir.version, problems: check.problems, message: '删除会让本体包失效' };
      }
      const cascaded = {
        links: links.length,
        actions: droppedActions.length,
        policies: trimmedPolicies.length,
      };
      if (args.dryRun) {
        return { ok: true, objectId: args.objectId, version: ir.version, cascaded, message: 'dryRun：未写盘' };
      }
      const saved = await store.save(entry.file, ir, { ifEtag: args.ifEtag || entry.etag });
      if (saved.conflict) {
        return {
          ok: false,
          conflict: true,
          etag: saved.etag,
          problems: saved.problems,
          message: '资产已被修改，请重新读取（ontology_get）后再写入',
        };
      }
      await noteHistory({ ts: Date.now(), packageId: ir.id, version: ir.version, op: 'delete_object', target: args.objectId, summary: '删除对象 ' + args.objectId + (args.cascade ? '（级联清理 ' + cascaded.links + ' 关系 / ' + cascaded.actions + ' 动作）' : ''), etag: saved.etag });
      return {
        ok: saved.ok,
        objectId: args.objectId,
        version: ir.version,
        cascaded,
        file: saved.file,etag: saved.etag,
        problems: saved.problems,
      };
    },
  });

  /* ------------------------------------------------------------------ *
   * ontology_execute_action  (write)
   * ------------------------------------------------------------------ */
  registerWrite({
    name: 'ontology_execute_action',
    description:
      '执行本体里声明的业务动作：校验入参 → 按动作与策略判定是否需要审批 → 把声明式副作用应用到事实数据 → 用规则回验执行前后变化。只有同时声明 inputSchema 与 effect 的动作可以执行；其余会列出来并说明原因。传 dryRun 只预览不落盘。',
    parameters: {
      type: 'object',
      properties: {
        packageId: { type: 'string' },
        actionId: { type: 'string' },
        input: { type: 'object', description: '动作入参，字段由动作的 inputSchema 决定' },
        dryRun: { type: 'boolean' },
      },
      required: ['packageId', 'actionId', 'input'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          actionId: { type: 'string' },
          approval: { type: 'string' },
          approvalRequired: { type: 'boolean' },
          matched: { type: 'number' },
          updated: { type: 'number' },
          changed: { type: 'array' },
          effects: { type: 'array' },
          rulesBefore: { type: 'object' },
          rulesAfter: { type: 'object' },
          problems: { type: 'array' },
          file: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value || {};
        if (!v.ok) {
          return text(
            lines([
              `未执行：${v.message || '未知原因'}`,
              ...(v.problems || []).map((p) => `  [${p.code}] ${p.field || p.path} — ${p.message}`),
            ])
          );
        }
        const out = [
          `${v.actionId}：命中 ${v.matched} 行，更新 ${v.updated} 行${v.file ? ' → ' + v.file : '（dryRun 未写盘）'}`,
        ];
        for (const change of (v.changed || []).slice(0, 5)) {
          out.push(`  ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`);
        }
        if (v.rulesBefore && v.rulesAfter) {
          out.push(`规则回验：违规 ${v.rulesBefore.violations} → ${v.rulesAfter.violations}`);
        }
        return text(out.join('\n'));
      },
    },
    execute: async (args, exec) => {
      const { entry } = await store.get(args.packageId);
      if (!entry || !entry.ir) {
        return { ok: false, actionId: args.actionId, message: `资产包不存在：${args.packageId}` };
      }
      const ir = entry.ir;
      const action = (ir.actions || []).find((a) => a.id === args.actionId);
      if (!action) {
        return {
          ok: false,
          actionId: args.actionId,
          message: `动作不存在：${args.actionId}。可用动作：${(ir.actions || []).map((a) => a.id).join(', ') || '无'}`,
        };
      }

      const runnable = executableActions(ir);
      if (!executableActions(ir).some((a) => a.id === action.id)) {
        return {
          ok: false,
          actionId: action.id,
          message: `动作 ${action.id} 还没有可执行的声明（需要 inputSchema + effect）`,
          problems: [
            { code: 'not-executable', field: 'effect', message: '未声明 effect，无法确定它改什么' },
          ],
          executable: runnable.map((a) => a.id),
        };
      }

      const validation = validateInput(action, args.input);
      if (!validation.ok) {
        return { ok: false, actionId: action.id, problems: validation.problems, message: '入参校验未通过' };
      }

      const policies = policiesFor(ir, action.id);
      const approvalRequired = action.approvalRequired === true || policies.some((p) => p.effect === 'require-approval');
      const gate = await gateWrite(exec, {
        toolName: 'ontology_execute_action',
        destructive: approvalRequired,
        reason: `执行动作 ${action.id}（${action.name}）写入 ${(action.writes || []).join(', ')}`,
      });
      if (!gate.allowed) {
        return { ok: false, actionId: action.id, approval: gate.outcome, approvalRequired, message: gate.message };
      }

      const loaded = await loadRecords(entry.file);
      if (!loaded.records) {
        return { ok: false, actionId: action.id, message: loaded.problems.join('；') };
      }

      const before = evaluateRules(ir, loaded.records).summary;
      const working = JSON.parse(JSON.stringify(loaded.records));
      const outcome = applyEffects(working, action, validation.value);
      const after = evaluateRules(ir, working).summary;

      if (outcome.matched === 0) {
        const targets = (outcome.effects || [])
          .map((e) => `${e.object}（${e.matched} 行）`)
          .join('、');
        return {
          ok: false,
          actionId: action.id,
          approval: gate.outcome,
          approvalRequired,
          matched: 0,
          message: `没有匹配到任何记录：${targets || '无副作用目标'}；入参 ${JSON.stringify(validation.value)}`,
        };
      }

      const rulesReport = {
        violations: before.violations,
        rows: before.rows,
        violatingRules: before.violatingRules,
      };
      const rulesAfter = {
        violations: after.violations,
        rows: after.rows,
        violatingRules: after.violatingRules,
        delta: before.violations - after.violations,
      };

      if (args.dryRun) {
        return {
          ok: true,
          actionId: action.id,
          approval: gate.outcome,
          approvalRequired,
          matched: outcome.matched,
          updated: outcome.updated,
          changed: outcome.changed,
        effects: outcome.effects,
          effects: outcome.effects,
          rulesBefore: rulesReport,
          rulesAfter,
          message: 'dryRun：未写盘',
        };
      }

      const recordsName = entry.file.replace(/\.ir\.json$/, '.records.json');
      const savedRecords = await store.saveRecords(recordsName, working, {
        ifEtag: args.ifEtag || (await store.readEtag(recordsName)),
      });
      if (savedRecords.conflict) {
        return {
          ok: false,
          actionId: action.id,
          conflict: true,
          etag: savedRecords.etag,
          problems: savedRecords.problems,
          message: '事实数据已被修改，请重新读取后再执行',
        };
      }
      await noteHistory({ ts: Date.now(), packageId: ir.id, version: ir.version, op: 'execute_action', target: action.id, summary: '执行动作 ' + action.id + '（命中 ' + outcome.matched + ' 行，更新 ' + outcome.updated + ' 行）', etag: savedRecords.etag });
      const file = savedRecords.file;
      return {
        ok: true,
        actionId: action.id,
        approval: gate.outcome,
        approvalRequired,
        matched: outcome.matched,
        updated: outcome.updated,
        changed: outcome.changed,
        effects: outcome.effects,
        rulesBefore: rulesReport,
        rulesAfter,
        file,
        etag: savedRecords.etag,
      };
    },
  });
}
