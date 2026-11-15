/**
 * Write routes for the panel: a person editing the ontology in the UI.
 *
 * These intentionally do NOT go through the Agent approval gate. The gate exists
 * to stop an *agent* from changing assets behind a human's back; a human clicking
 * Save is already the human decision. This sits at the same level as editing
 * `assets/*.ir.json` by hand, which the README has always documented as ungated.
 *
 * What they DO get is CSRF protection: a write route on a localhost web server is
 * reachable by any page the user happens to have open, so every mutation requires
 * a same-origin JSON request.
 */
import { validateIr } from './ir.mjs';
import { resolveRule } from './rules.mjs';

const MAX_BODY = 256 * 1024;

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { code: 'too-large' }));
        req.destroy?.();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) {
        reject(Object.assign(new Error('空请求体'), { code: 'empty' }));
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(Object.assign(new Error('请求体不是合法 JSON：' + error.message), { code: 'bad-json' }));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Reject cross-site writes. A browser sends `origin` on cross-origin POSTs and
 * `sec-fetch-site` on all fetches; a cross-site attempt fails both checks, while
 * the panel's own same-origin fetch passes. Non-browser clients (curl, tests)
 * send neither and are allowed — they cannot be tricked into a request.
 */
export function isSameOrigin(req) {
  const site = String(req.headers['sec-fetch-site'] || '');
  if (site && site !== 'same-origin' && site !== 'none') return false;

  const origin = String(req.headers.origin || '');
  if (!origin) return true;
  try {
    const host = String(req.headers.host || '');
    const parsed = new URL(origin);
    return parsed.host === host;
  } catch {
    return false;
  }
}

function objectProblems(ir, objectId) {
  const objects = ir.objects || [];
  const index = objects.findIndex((o) => o.id === objectId);
  if (index < 0) return [{ path: '$.objects', code: 'not-found', message: `对象不存在：${objectId}` }];
  return [];
}

/**
 * @param {{ store: object, prefix: string, writeMode: string, noteHistory: Function }} options
 */
export function registerWriteRoutes(ctx, options) {
  const { store, prefix } = options;

  const handler = async (req, res) => {
    try {
      if (req.method !== 'POST') {
        send(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      if (!isSameOrigin(req)) {
        send(res, 403, { ok: false, error: 'cross_origin', message: '拒绝跨站写入请求' });
        return;
      }
      if (options.writeMode === 'readonly') {
        send(res, 403, { ok: false, error: 'readonly', message: '只读模式：写工具与写接口都没有启用' });
        return;
      }

      const pathname = new URL(req.url ?? '/', 'http://placeholder').pathname;

      /* ---------------- save one object ---------------- */
      if (pathname === `${prefix}/write/save-object`) {
        let body;
        try {
          body = await readJson(req);
        } catch (error) {
          send(res, 400, { ok: false, error: 'bad_body', message: error.message });
          return;
        }
        const object = body && body.object;
        if (!object || typeof object !== 'object' || typeof object.id !== 'string' || !object.id.trim()) {
          send(res, 400, { ok: false, error: 'bad_body', message: 'object 必须带 id' });
          return;
        }

        const { entry } = await store.get(body.packageId);
        if (!entry || !entry.ir) {
          send(res, 404, { ok: false, error: 'not_found', message: `资产包不存在：${body.packageId}` });
          return;
        }

        // Validate against the merged package before touching the disk, so the
        // UI can show the validator's own messages instead of a generic failure.
        const preview = JSON.parse(JSON.stringify(entry.ir));
        const list = Array.isArray(preview.objects) ? preview.objects : (preview.objects = []);
        const at = list.findIndex((o) => o.id === object.id);
        const action = at >= 0 ? 'updated' : 'created';
        if (at >= 0) list[at] = object;
        else list.push(object);

        const check = validateIr(preview);
        if (!check.ok) {
          send(res, 422, { ok: false, error: 'invalid', action, problems: check.problems });
          return;
        }

        const applied = await store.update(entry.file, (draft) => {
          const target = Array.isArray(draft.objects) ? draft.objects : (draft.objects = []);
          const index = target.findIndex((o) => o.id === object.id);
          if (index >= 0) target[index] = object;
          else target.push(object);
          return { ok: true };
        });
        if (!applied.ok) {
          send(res, 422, { ok: false, error: 'invalid', action, problems: applied.problems });
          return;
        }
        await options.noteHistory?.({
          ts: Date.now(),
          packageId: entry.ir.id,
          version: entry.ir.version,
          op: 'upsert_object',
          target: object.id,
          summary: (action === 'created' ? '新增对象 ' : '更新对象 ') + object.id + '（面板）',
          etag: applied.etag,
        });
        send(res, 200, { ok: true, action, objectId: object.id, version: entry.ir.version, etag: applied.etag });
        return;
      }

      /* ---------------- delete one object ---------------- */
      if (pathname === `${prefix}/write/delete-object`) {
        let body;
        try {
          body = await readJson(req);
        } catch (error) {
          send(res, 400, { ok: false, error: 'bad_body', message: error.message });
          return;
        }
        const objectId = body && body.objectId;
        const { entry } = await store.get(body.packageId);
        if (!entry || !entry.ir) {
          send(res, 404, { ok: false, error: 'not_found', message: `资产包不存在：${body.packageId}` });
          return;
        }

        const preview = JSON.parse(JSON.stringify(entry.ir));
        const missing = objectProblems(preview, objectId);
        if (missing.length) {
          send(res, 404, { ok: false, error: 'not_found', problems: missing });
          return;
        }

        if (!body.cascade) {
          // Refuse rather than silently break references; tell the UI what depends on it.
          const incoming = (preview.links || []).filter((l) => l.target === objectId);
          const outgoing = (preview.links || []).filter((l) => l.source === objectId);
          const actions = (preview.actions || []).filter((a) => (a.writes || []).includes(objectId));
          const agents = (preview.agents || []).filter((a) => (a.usesObjects || []).includes(objectId));
          if (incoming.length + outgoing.length + actions.length + agents.length > 0) {
            send(res, 409, {
              ok: false,
              error: 'has_dependents',
              message: '这个对象还被引用，确认连带清理后才能删除',
              dependents: {
                links: incoming.length + outgoing.length,
                actions: actions.map((a) => a.id),
                agents: agents.map((a) => a.id),
              },
            });
            return;
          }
        }

        const applied = await store.update(entry.file, (draft) => {
          draft.objects = (draft.objects || []).filter((o) => o.id !== objectId);
          if (body.cascade) {
            draft.links = (draft.links || []).filter((l) => l.source !== objectId && l.target !== objectId);
            const droppedActions = [];
            draft.actions = (draft.actions || []).filter((a) => {
              if (!(a.writes || []).includes(objectId)) return true;
              const writes = (a.writes || []).filter((w) => w !== objectId);
              // An effect that targets the deleted object can no longer apply;
              // mirror the tool's cascade exactly, or the package goes invalid.
              let effect = a.effect;
              if (Array.isArray(a.effect)) {
                const kept = a.effect.filter((e) => e && e.object !== objectId);
                effect = kept.length ? kept : undefined;
              } else if (a.effect && a.effect.object === objectId) {
                effect = undefined;
              }
              if (writes.length === 0) {
                droppedActions.push(a.id);
                return false;
              }
              a.writes = writes;
              if (effect === undefined) delete a.effect;
              else a.effect = effect;
              return true;
            });
            draft.policies = (draft.policies || [])
              .map((p) => (Array.isArray(p.appliesTo) ? Object.assign({}, p, { appliesTo: p.appliesTo.filter((a) => !droppedActions.includes(a)) }) : p))
              .filter((p) => !Array.isArray(p.appliesTo) || p.appliesTo.length > 0);
            draft.agents = (draft.agents || []).map((a) =>
              Object.assign({}, a, {
                usesObjects: (a.usesObjects || []).filter((id) => id !== objectId),
                actions: (a.actions || []).filter((id) => !droppedActions.includes(id)),
              })
            );
          }
          return { ok: true };
        });
        if (!applied.ok) {
          send(res, 422, { ok: false, error: 'invalid', problems: applied.problems });
          return;
        }
        await options.noteHistory?.({
          ts: Date.now(),
          packageId: entry.ir.id,
          version: entry.ir.version,
          op: 'delete_object',
          target: objectId,
          summary: `删除对象 ${objectId}${body.cascade ? '（连带清理）' : ''}（面板）`,
          etag: applied.etag,
        });
        send(res, 200, { ok: true, objectId, etag: applied.etag });
        return;
      }

      /* ---------------- save one relation ---------------- */
      if (pathname === `${prefix}/write/save-link`) {
        let body;
        try {
          body = await readJson(req);
        } catch (error) {
          send(res, 400, { ok: false, error: 'bad_body', message: error.message });
          return;
        }
        const link = body && body.link;
        if (!link || typeof link !== 'object' || typeof link.id !== 'string' || !link.id.trim()) {
          send(res, 400, { ok: false, error: 'bad_body', message: 'link 必须带 id' });
          return;
        }

        const { entry } = await store.get(body.packageId);
        if (!entry || !entry.ir) {
          send(res, 404, { ok: false, error: 'not_found', message: `资产包不存在：${body.packageId}` });
          return;
        }

        const preview = JSON.parse(JSON.stringify(entry.ir));
        const links = Array.isArray(preview.links) ? preview.links : (preview.links = []);
        const at = links.findIndex((l) => l.id === link.id);
        const action = at >= 0 ? 'updated' : 'created';
        if (at >= 0) links[at] = link;
        else links.push(link);

        const check = validateIr(preview);
        if (!check.ok) {
          send(res, 422, { ok: false, error: 'invalid', action, problems: check.problems });
          return;
        }

        const applied = await store.update(entry.file, (draft) => {
          const target = Array.isArray(draft.links) ? draft.links : (draft.links = []);
          const index = target.findIndex((l) => l.id === link.id);
          if (index >= 0) target[index] = link;
          else target.push(link);
          return { ok: true };
        });
        if (!applied.ok) {
          send(res, 422, { ok: false, error: 'invalid', action, problems: applied.problems });
          return;
        }
        await options.noteHistory?.({
          ts: Date.now(),
          packageId: entry.ir.id,
          version: entry.ir.version,
          op: 'upsert_link',
          target: link.id,
          summary: (action === 'created' ? '新增关系 ' : '更新关系 ') + link.id + '（面板）',
          etag: applied.etag,
        });
        send(res, 200, { ok: true, action, linkId: link.id, version: entry.ir.version, etag: applied.etag });
        return;
      }

      /* ---------------- delete one relation ---------------- */
      if (pathname === `${prefix}/write/delete-link`) {
        let body;
        try {
          body = await readJson(req);
        } catch (error) {
          send(res, 400, { ok: false, error: 'bad_body', message: error.message });
          return;
        }
        const { entry } = await store.get(body.packageId);
        if (!entry || !entry.ir) {
          send(res, 404, { ok: false, error: 'not_found', message: `资产包不存在：${body.packageId}` });
          return;
        }
        const exists = (entry.ir.links || []).some((l) => l.id === body.linkId);
        if (!exists) {
          send(res, 404, { ok: false, error: 'not_found', message: `关系不存在：${body.linkId}` });
          return;
        }

        const applied = await store.update(entry.file, (draft) => {
          draft.links = (draft.links || []).filter((l) => l.id !== body.linkId);
          return { ok: true };
        });
        if (!applied.ok) {
          send(res, 422, { ok: false, error: 'invalid', problems: applied.problems });
          return;
        }
        await options.noteHistory?.({
          ts: Date.now(),
          packageId: entry.ir.id,
          version: entry.ir.version,
          op: 'delete_link',
          target: body.linkId,
          summary: `删除关系 ${body.linkId}（面板）`,
          etag: applied.etag,
        });
        send(res, 200, { ok: true, linkId: body.linkId, etag: applied.etag });
        return;
      }

      /* ---------------- save one rule ---------------- */
      if (pathname === `${prefix}/write/save-rule`) {
        let body;
        try {
          body = await readJson(req);
        } catch (error) {
          send(res, 400, { ok: false, error: 'bad_body', message: error.message });
          return;
        }
        const rule = body && body.rule;
        if (!rule || typeof rule !== 'object' || typeof rule.id !== 'string' || !rule.id.trim()) {
          send(res, 400, { ok: false, error: 'bad_body', message: 'rule 必须带 id' });
          return;
        }

        const { entry } = await store.get(body.packageId);
        if (!entry || !entry.ir) {
          send(res, 404, { ok: false, error: 'not_found', message: `资产包不存在：${body.packageId}` });
          return;
        }

        // The IR validator checks shape only; the expression has to parse before
        // it is worth saving, so report that here rather than at evaluation time.
        let resolved = null;
        try {
          resolved = resolveRule(entry.ir, rule);
          if (resolved.reason) {
            send(res, 422, {
              ok: false,
              error: 'invalid_expression',
              problems: [{ path: '$.rules.expression', code: 'rule-unresolved', message: resolved.reason }],
            });
            return;
          }
        } catch (error) {
          send(res, 422, {
            ok: false,
            error: 'invalid_expression',
            problems: [{ path: '$.rules.expression', code: 'bad-expression', message: String(error && error.message) }],
          });
          return;
        }

        const preview = JSON.parse(JSON.stringify(entry.ir));
        const rules = Array.isArray(preview.rules) ? preview.rules : (preview.rules = []);
        const at = rules.findIndex((r) => r.id === rule.id);
        const action = at >= 0 ? 'updated' : 'created';
        if (at >= 0) rules[at] = rule;
        else rules.push(rule);

        const check = validateIr(preview);
        if (!check.ok) {
          send(res, 422, { ok: false, error: 'invalid', action, problems: check.problems });
          return;
        }

        const applied = await store.update(entry.file, (draft) => {
          const target = Array.isArray(draft.rules) ? draft.rules : (draft.rules = []);
          const index = target.findIndex((r) => r.id === rule.id);
          if (index >= 0) target[index] = rule;
          else target.push(rule);
          return { ok: true };
        });
        if (!applied.ok) {
          send(res, 422, { ok: false, error: 'invalid', action, problems: applied.problems });
          return;
        }
        await options.noteHistory?.({
          ts: Date.now(),
          packageId: entry.ir.id,
          version: entry.ir.version,
          op: 'upsert_rule',
          target: rule.id,
          summary: (action === 'created' ? '新增规则 ' : '更新规则 ') + rule.id + '（面板）',
          etag: applied.etag,
        });
        send(res, 200, {
          ok: true,
          action,
          ruleId: rule.id,
          version: entry.ir.version,
          etag: applied.etag,
          bindsTo: resolved.objectId,
        });
        return;
      }

      /* ---------------- delete one rule ---------------- */
      if (pathname === `${prefix}/write/delete-rule`) {
        let body;
        try {
          body = await readJson(req);
        } catch (error) {
          send(res, 400, { ok: false, error: 'bad_body', message: error.message });
          return;
        }
        const { entry } = await store.get(body.packageId);
        if (!entry || !entry.ir) {
          send(res, 404, { ok: false, error: 'not_found', message: `资产包不存在：${body.packageId}` });
          return;
        }
        if (!(entry.ir.rules || []).some((r) => r.id === body.ruleId)) {
          send(res, 404, { ok: false, error: 'not_found', message: `规则不存在：${body.ruleId}` });
          return;
        }

        const applied = await store.update(entry.file, (draft) => {
          draft.rules = (draft.rules || []).filter((r) => r.id !== body.ruleId);
          return { ok: true };
        });
        if (!applied.ok) {
          send(res, 422, { ok: false, error: 'invalid', problems: applied.problems });
          return;
        }
        await options.noteHistory?.({
          ts: Date.now(),
          packageId: entry.ir.id,
          version: entry.ir.version,
          op: 'delete_rule',
          target: body.ruleId,
          summary: `删除规则 ${body.ruleId}（面板）`,
          etag: applied.etag,
        });
        send(res, 200, { ok: true, ruleId: body.ruleId, etag: applied.etag });
        return;
      }

      send(res, 404, { ok: false, error: 'unknown_route' });
    } catch (error) {
      send(res, 500, { ok: false, error: 'internal', message: String(error && error.message) });
    }
  };

  return ctx.webServer.register({ path: `${prefix}/write`, handler });
}
