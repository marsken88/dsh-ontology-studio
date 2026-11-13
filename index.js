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
import { createStore } from './lib/store.mjs';
import { impactOf, summarizeIr } from './lib/ir.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** `tools` is a hard dependency: without it this plugin has nothing to offer. */
export const inject = ['tools'];

const text = (value) => [{ type: 'text', text: value }];

const lines = (items) => items.filter(Boolean).join('\n');

export function apply(ctx, config = {}) {
  const assetsDir = config.assetsDir ? path.resolve(config.assetsDir) : path.join(here, 'assets');
  const store = createStore({ dir: assetsDir });

  const register = (definition) => {
    const add = () => ctx.tools.register(definition);
    ctx.effect(add);
  };

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
}
