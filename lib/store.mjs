/**
 * Ontology IR registry.
 *
 * Reads `<dir>/*.ir.json`, keeps the parsed result keyed by file mtime, and
 * re-validates whenever a file changes. Deliberately read-only and
 * dependency-free: the asset directory is the source of truth, so editing a
 * JSON file is the whole "deploy" step for phase 1.
 */
import { readdir, readFile, stat, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { validateIr, summarizeIr } from './ir.mjs';

const SUFFIX = '.ir.json';

let tmpCounter = 0;

/**
 * Write a file so that a crash mid-write can never leave a half-written package
 * behind: the bytes go to a sibling temp file first and only replace the target
 * once they are complete. `rename` is atomic within a filesystem, which is the
 * case here because the temp file lives next to the target.
 */
async function writeAtomic(target, body) {
  tmpCounter += 1;
  const tmp = `${target}.${process.pid}.${tmpCounter}.tmp`;
  try {
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, target);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

/** Content fingerprint of a file's bytes, used for compare-and-swap writes. */
export function etagOf(text) {
  return 'sha256-' + createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** `1.2.3` + bump → next version. Unknown bump falls back to patch. */
export function bumpVersion(version, bump = 'patch') {
  const parts = String(version).split('.').map((n) => Number.parseInt(n, 10));
  const [major, minor, patch] = [parts[0] || 0, parts[1] || 0, parts[2] || 0];
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function createStore(options) {
  const dir = path.resolve(options.dir);
  const cache = new Map(); // file -> { mtimeMs, entry }

  /**
   * Per-file async lock. Every mutation runs through it, so two tool calls can
   * never interleave between "read the file" and "write it back" inside this
   * process — the lost-update window that a plain read-modify-write leaves open.
   */
  const locks = new Map();
  function withLock(key, fn) {
    const previous = locks.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    locks.set(
      key,
      run.then(
        () => {},
        () => {}
      )
    );
    return run;
  }

  async function currentEtag(file) {
    try {
      return etagOf(await readFile(path.join(dir, file), 'utf8'));
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function scan() {
    let names;
    try {
      names = await readdir(dir);
    } catch (error) {
      if (error && error.code === 'ENOENT') return { files: [], missingDir: true };
      throw error;
    }
    return { files: names.filter((n) => n.endsWith(SUFFIX)).sort(), missingDir: false };
  }

  async function loadOne(file) {
    const full = path.join(dir, file);
    let info;
    try {
      info = await stat(full);
    } catch {
      cache.delete(file);
      return null;
    }
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === info.mtimeMs) return hit.entry;

    let entry;
    try {
      const text = await readFile(full, 'utf8');
      const ir = JSON.parse(text);
      const { ok, problems } = validateIr(ir);
      entry = {
        file,
        path: full,
        etag: etagOf(text),
        ir,
        ok,
        problems,
        summary: ok ? summarizeIr(ir) : null,
      };
    } catch (error) {
      entry = {
        file,
        path: full,
        ir: null,
        ok: false,
        problems: [{ path: '$', code: 'unreadable', message: `${file} 无法解析：${error.message}` }],
        summary: null,
      };
    }
    cache.set(file, { mtimeMs: info.mtimeMs, entry });
    return entry;
  }

  /** Every package in the directory, healthy or not. */
  async function list() {
    const { files, missingDir } = await scan();
    const entries = [];
    for (const file of files) {
      const entry = await loadOne(file);
      if (entry) entries.push(entry);
    }
    const seen = new Set();
    for (const file of [...cache.keys()]) {
      if (!files.includes(file)) cache.delete(file);
    }
    for (const entry of entries) {
      if (entry.ir) {
        if (seen.has(entry.ir.id)) {
          entry.ok = false;
          entry.problems = [
            ...entry.problems,
            { path: '$.id', code: 'duplicate-package', message: `资产包 id 重复：${entry.ir.id}` },
          ];
        } else {
          seen.add(entry.ir.id);
        }
      }
    }
    return { dir, missingDir, entries };
  }

  async function get(packageId) {
    const { entries, missingDir } = await list();
    const entry = entries.find((e) => (e.ir ? e.ir.id === packageId : e.file === packageId));
    return { entry, missingDir, entries };
  }

  /**
   * Write one package back to disk. Invalid IR is refused unless `force` is set,
   * so the asset directory never accumulates an unloadable file.
   * @returns {Promise<{ ok: boolean, problems: Array, file?: string }>}
   */
  /**
   * Write one package back. Invalid IR is refused unless `force` is set, so the
   * asset directory never accumulates an unloadable file.
   *
   * `ifEtag` is compare-and-swap: when supplied and the file changed since the
   * caller read it, nothing is written and `conflict: true` is returned with the
   * current etag so the caller can re-read and decide.
   * @returns {Promise<{ ok: boolean, problems: Array, file?: string, etag?: string, conflict?: boolean, previousEtag?: string }>}
   */
  async function save(file, ir, options = {}) {
    const { ok, problems } = validateIr(ir);
    if (!ok && !options.force) return { ok: false, problems };
    const body = JSON.stringify(ir, null, 2) + '\n';
    return withLock(file, async () => {
      if (options.ifEtag) {
        const current = await currentEtag(file);
        if (current && current !== options.ifEtag) {
          return {
            ok: false,
            conflict: true,
            previousEtag: options.ifEtag,
            etag: current,
            problems: [{ path: '$', code: 'conflict', message: '资产在你读取之后被修改过，请重新读取再写入' }],
          };
        }
      }
      await mkdir(dir, { recursive: true });
      const target = path.join(dir, file);
      await writeAtomic(target, body);
      cache.delete(file);
      return { ok, problems, file: target, etag: etagOf(body) };
    });
  }

  /**
   * Read-modify-write as one atomic unit.
   *
   * `save` only locks the write, so two concurrent upserts each read the same
   * base and then fight over the compare-and-swap — one wins, the rest get a
   * conflict. That is right for an explicit `ifEtag`, but wrong for "add this
   * object": it is a serializable operation and should simply queue.
   *
   * `mutate` receives a deep copy of the current IR and may modify it in place
   * or return `{ ir, result }`. Everything (read, mutate, validate, write)
   * happens inside the per-file lock.
   */
  async function update(file, mutate, options = {}) {
    return withLock(file, async () => {
      const entry = await loadOne(file);
      if (!entry || !entry.ir) {
        return { ok: false, code: 'not-found', problems: [{ path: '$', code: 'not-found', message: `文件不可读或不存在：${file}` }] };
      }
      if (options.ifEtag && entry.etag !== options.ifEtag) {
        return {
          ok: false,
          conflict: true,
          previousEtag: options.ifEtag,
          etag: entry.etag,
          problems: [{ path: '$', code: 'conflict', message: '资产在你读取之后被修改过，请重新读取再写入' }],
        };
      }

      const draft = JSON.parse(JSON.stringify(entry.ir));
      const outcome = (await mutate(draft, entry)) || {};
      const next = outcome.ir || (outcome.draft === undefined ? draft : outcome.draft);
      if (!next) {
        return { ok: false, problems: outcome.problems || [{ path: '$', code: 'no-ir', message: 'mutate 没有返回 IR' }] };
      }
      // A mutate that reports a problem (e.g. duplicate id) aborts without writing.
      if (outcome.problems && outcome.problems.length && outcome.ok === false) {
        return { ok: false, problems: outcome.problems, result: outcome };
      }
      const { ok, problems } = validateIr(next);
      if (!ok && !options.force) return { ok: false, problems, result: outcome };

      const body = JSON.stringify(next, null, 2) + '\n';
      await mkdir(dir, { recursive: true });
      const target = path.join(dir, file);
      await writeAtomic(target, body);
      cache.delete(file);
      return { ok, problems, file: target, etag: etagOf(body), ir: next, result: outcome };
    });
  }

  /** Write the fact-data file an action's effect applies to. */
  async function saveRecords(file, data, options = {}) {
    const body = JSON.stringify(data, null, 2) + '\n';
    return withLock(file, async () => {
      if (options.ifEtag) {
        const current = await currentEtag(file);
        if (current && current !== options.ifEtag) {
          return {
            ok: false,
            conflict: true,
            previousEtag: options.ifEtag,
            etag: current,
            problems: [{ path: '$', code: 'conflict', message: '事实数据在你读取之后被修改过，请重新读取再执行' }],
          };
        }
      }
      await mkdir(dir, { recursive: true });
      const target = path.join(dir, file);
      await writeAtomic(target, body);
      return { ok: true, file: target, etag: etagOf(body) };
    });
  }

  /** Current etag of a file, or null when it does not exist. */
  async function readEtag(file) {
    return currentEtag(file);
  }

  return { dir, list, get, save, update, saveRecords, readEtag };
}