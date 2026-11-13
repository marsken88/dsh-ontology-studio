/**
 * Read-only JSON API for the panel.
 *
 * The Web GUI half cannot call Host services directly, so the ontology the
 * Agent sees through `ontology_*` is served to the panel over same-origin HTTP.
 * Routes are registered on the shared `webServer`, matching the pattern other
 * Web-GUI plugins use; the browser sends its own session with the request.
 */
import { impactOf } from './ir.mjs';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function json(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/**
 * @param {{ webServer: { register(route: unknown): () => void } }} ctx
 * @param {{ store: ReturnType<import('./store.mjs').createStore> }} options
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

      json(res, 404, { ok: false, error: 'unknown_route', path });
    } catch (error) {
      json(res, 500, { ok: false, error: 'internal', message: String(error && error.message) });
    }
  };

  return ctx.webServer.register({ kind: 'prefix', path: prefix, handler });
}
