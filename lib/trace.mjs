/**
 * Append-only execution trace for ontology tool calls.
 *
 * The Observability Studio should describe what an agent actually did, not a
 * mock. Every `ontology_*` call is recorded here as one JSON line:
 *
 *   { ts, tool, ok, ms, summary, error }
 *
 * The file is capped: when it grows past `maxLines`, the newest `maxLines`
 * entries are rewritten once. That keeps a long-lived profile from growing an
 * unbounded log while staying dependency-free and crash-tolerant (a truncated
 * last line is skipped on read).
 */
import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const SUMMARY_LIMIT = 240;

export function createTraceStore(options) {
  const file = path.resolve(options.file);
  const maxLines = options.maxLines ?? 500;
  const enabled = options.enabled !== false;

  async function append(entry) {
    if (!enabled) return;
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, JSON.stringify(entry) + '\n', 'utf8');
      const count = await lineCount();
      if (count > maxLines) await trim();
    } catch {
      /* Tracing must never fail a tool call. */
    }
  }

  async function readLines() {
    try {
      const text = await readFile(file, 'utf8');
      const lines = text.split('\n').filter((l) => l.trim() !== '');
      const entries = [];
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line));
        } catch {
          /* A torn final line from a crash is skipped, not fatal. */
        }
      }
      return entries;
    } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async function lineCount() {
    return (await readLines()).length;
  }

  async function trim() {
    const entries = await readLines();
    const kept = entries.slice(-maxLines);
    await writeFile(file, kept.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  }

  /** Newest first. */
  async function list(limit = 50) {
    const entries = await readLines();
    return entries.slice(-Math.max(1, Math.min(limit, maxLines))).reverse();
  }

  async function clear() {
    await writeFile(file, '', 'utf8');
  }

  return { file, enabled, append, list, clear };
}

/** Compact one tool call into a bounded, human-readable line. */
export function summarizeCall(tool, args) {
  let text;
  try {
    text = JSON.stringify(args);
  } catch {
    text = String(args);
  }
  if (text === undefined) text = '';
  const parts = [];
  if (args && typeof args === 'object') {
    for (const key of ['packageId', 'objectId', 'linkId', 'id', 'object', 'link']) {
      if (args[key] === undefined) continue;
      const value = args[key];
      parts.push(typeof value === 'string' ? value : typeof value === 'object' && value !== null ? value.id || '{…}' : String(value));
    }
  }
  const detail = parts.length ? parts.join(' · ') : text;
  return `${tool}: ${detail}`.slice(0, SUMMARY_LIMIT);
}
