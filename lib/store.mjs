/**
 * Ontology IR registry.
 *
 * Reads `<dir>/*.ir.json`, keeps the parsed result keyed by file mtime, and
 * re-validates whenever a file changes. Deliberately read-only and
 * dependency-free: the asset directory is the source of truth, so editing a
 * JSON file is the whole "deploy" step for phase 1.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { validateIr, summarizeIr } from './ir.mjs';

const SUFFIX = '.ir.json';

export function createStore(options) {
  const dir = path.resolve(options.dir);
  const cache = new Map(); // file -> { mtimeMs, entry }

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

  return { dir, list, get };
}
