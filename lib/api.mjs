/**
 * Read-only JSON API for the panel.
 *
 * The Web GUI half cannot call Host services directly, so the ontology the
 * Agent sees through `ontology_*` is served to the panel over same-origin HTTP.
 * Routes are registered on the shared `webServer`, matching the pattern other
 * Web-GUI plugins use; the browser sends its own session with the request.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { impactOf } from './ir.mjs';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function json(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/**
 * @param {{ webServer: { register(route: unknown): () => void } }} ctx
 * @param {{ store: ReturnType<import('./store.mjs').createStore>, prefix: string, readOnly?: boolean }} options
 * @returns {() => void} disposer
 */
export function registerRoutes(ctx, options) {
  const { store, prefix } = options;

  const handler = async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        json(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      const url = new URL(req.url ?? '/', 'http://placeholder');
      const path = url.pathname;

      if (path === `${prefix}/status`) {
        const { dir, entries, missingDir } = await store.list();
        json(res, 200, {
          ok: true,
          value: {
            dir,
            missingDir,
            readOnly: options.readOnly === true,
            approval: options.approval || 'destructive',
            packages: entries.map((entry) => ({
              ...(entry.summary ?? { id: entry.ir ? entry.ir.id : entry.file }),
              file: entry.file,
              ok: entry.ok,
              problemCount: entry.problems.length,
            })),
            problems: entries.flatMap((entry) =>
              entry.problems.map((p) => ({ package: entry.ir ? entry.ir.id : entry.file, ...p }))
            ),
          },
        });
        return;
      }

      if (path === `${prefix}/package`) {
        const id = url.searchParams.get('id');
        if (!id) {
          json(res, 400, { ok: false, error: 'missing_id' });
          return;
        }
        const { entry } = await store.get(id);
        if (!entry || !entry.ir) {
          json(res, 404, { ok: false, error: 'not_found', id });
          return;
        }
        json(res, 200, {
          ok: true,
          value: {
            file: entry.file,
            etag: entry.etag,
            ok: entry.ok,
            problems: entry.problems,
            ir: entry.ir,
          },
        });
        return;
      }

      if (path === `${prefix}/impact`) {
        const id = url.searchParams.get('id');
        const objectId = url.searchParams.get('object');
        if (!id || !objectId) {
          json(res, 400, { ok: false, error: 'missing_params' });
          return;
        }
        const { entry } = await store.get(id);
        if (!entry || !entry.ir) {
          json(res, 404, { ok: false, error: 'not_found', id });
          return;
        }
        const impact = impactOf(entry.ir, objectId);
        if (!impact) {
          json(res, 404, { ok: false, error: 'object_not_found', objectId });
          return;
        }
        json(res, 200, { ok: true, value: impact });
        return;
      }

      if (path === `${prefix}/traces`) {
        if (!options.trace) {
          json(res, 200, { ok: true, value: { enabled: false, entries: [] } });
          return;
        }
        const limitParam = Number.parseInt(url.searchParams.get('limit') || '40', 10);
        const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(limitParam, 200)) : 40;
        json(res, 200, {
          ok: true,
          value: { enabled: options.trace.enabled !== false, entries: await options.trace.list(limit) },
        });
        return;
      }

      if (path === `${prefix}/records`) {
        const id = url.searchParams.get('id');
        if (!id) {
          json(res, 400, { ok: false, error: 'missing_id' });
          return;
        }
        const { entry } = await store.get(id);
        if (!entry || !entry.ir) {
          json(res, 404, { ok: false, error: 'not_found', id });
          return;
        }
        const objectId = url.searchParams.get('object');
        const limitParam = Number.parseInt(url.searchParams.get('limit') || '5', 10);
        const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(limitParam, 50)) : 5;
        const recordsFile = path.join(store.dir, entry.file.replace(/\.ir\.json$/, '.records.json'));
        let data = null;
        try {
          data = JSON.parse(await readFile(recordsFile, 'utf8'));
        } catch (error) {
          json(res, 404, { ok: false, error: 'records_missing', file: recordsFile });
          return;
        }
        const all = data.objects || {};
        const ids = objectId ? [objectId] : Object.keys(all);
        json(res, 200, {
          ok: true,
          value: {
            file: recordsFile,
            totalRows: Object.keys(all).reduce((n, key) => n + (Array.isArray(all[key]) ? all[key].length : 0), 0),
            objects: ids.map((oid) => {
              const rows = Array.isArray(all[oid]) ? all[oid] : [];
              return { id: oid, rows: rows.length, sample: rows.slice(0, limit) };
            }),
          },
        });
        return;
      }

      json(res, 404, { ok: false, error: 'unknown_route', path });
    } catch (error) {
      json(res, 500, { ok: false, error: 'internal', message: String(error && error.message) });
    }
  };

  return ctx.webServer.register({ kind: 'prefix', path: prefix, handler });
}
