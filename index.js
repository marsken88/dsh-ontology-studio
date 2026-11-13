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
import { createStore, bumpVersion } from './lib/store.mjs';
import { impactOf, summarizeIr, validateIr } from './lib/ir.mjs';
import { registerRoutes } from './lib/api.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Single source of the panel's HTTP namespace. */
const ROUTE_PREFIX = '/dsh-ontology-studio';

/** `tools` is a hard dependency: without it this plugin has nothing to offer. */
export const inject = ['tools'];

const text = (value) => [{ type: 'text', text: value }];

const lines = (items) => items.filter(Boolean).join('\n');

export function apply(ctx, config = {}) {
  const assetsDir = config.assetsDir ? path.resolve(config.assetsDir) : path.join(here, 'assets');
  const store = createStore({ dir: assetsDir });

  /** `readonly` removes write tools entirely; `open` (default) keeps them. */
  const writeMode = config.writeMode === 'readonly' ? 'readonly' : 'open';

  /** Which writes need a human decision: never | destructive (default) | all. */
  const approvalMode = ['never', 'destructive', 'all'].includes(config.approval) ? config.approval : 'destructive';

  /* The panel is a separate process; it reads the same store over HTTP. */
  ctx.inject(['webServer'], (webCtx) => {
    registerRoutes(webCtx, { store, prefix: ROUTE_PREFIX, readOnly: writeMode === 'readonly', approval: approvalMode });
  });

  const register = (definition) => {
    const add = () => ctx.tools.register(definition);
    ctx.effect(add);
  };

  /** Write tools disappear entirely in readonly mode — not a UI toggle. */
  const registerWrite = (definition) => {
    if (writeMode === 'readonly') return;
    register(definition);
  };

  /**
   * Per-call approval gate: only `'allowed-once'` grants a write. A missing
   * service, a missing session, or a thrown request (what an idle turn yields)
   * all fail closed. Destructiveness and mode come from the caller.
   */
  async function gateWrite(exec, spec) {
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
      return { found: true, package: summarizeIr(ir), object: obj, links, rules, actions };
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
        if (v.ok) return text(`✓ ${(v.checked || []).length} 个本体包全部通过校验（${v.dir}）`);
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
      return {
        ok: problems.length === 0,
        dir,
        checked: scope.map((e) => (e.ir ? e.ir.id : e.file)),
        problems,
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
            `${v.action === 'created' ? '已新增' : '已更新'}对象 ${v.objectId}（${v.packageId} v${v.version}）→ ${v.file}`
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
        return { ok: true, action, objectId: args.object.id, version: ir.version, message: 'dryRun：校验通过，未写盘' };
      }
      const saved = await store.save(entry.file, ir);
      return {
        ok: saved.ok,
        action,
        objectId: args.object.id,
        packageId: ir.id,
        version: ir.version,
        file: saved.file,
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
      const saved = await store.save(entry.file, ir);
      return { ok: saved.ok, from, to, file: saved.file, problems: saved.problems };
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
      if (args.dryRun) return { ok: true, action, linkId: args.link.id, version: ir.version, message: 'dryRun：校验通过，未写盘' };
      const saved = await store.save(entry.file, ir);
      return { ok: saved.ok, action, linkId: args.link.id, version: ir.version, file: saved.file, problems: saved.problems };
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
      const saved = await store.save(entry.file, ir);
      return { ok: saved.ok, linkId: args.linkId, file: saved.file, problems: saved.problems };
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
          if (!(a.writes || []).includes(args.objectId)) return a;
          const writes = a.writes.filter((w) => w !== args.objectId);
          if (writes.length === 0) {
            droppedActions.push(a.id);
            return null;
          }
          return Object.assign({}, a, { writes });
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
      const saved = await store.save(entry.file, ir);
      return {
        ok: saved.ok,
        objectId: args.objectId,
        version: ir.version,
        cascaded,
        file: saved.file,
        problems: saved.problems,
      };
    },
  });
}
