/**
 * Asset registry: what can be installed, what is installed, and whether the
 * install order keeps dependencies satisfied.
 *
 * The catalog is a directory of `*.ir.json` packages that are *available* but
 * not loaded; the asset directory is what the runtime actually reads. Installing
 * copies one into the other, and both directions check `dependsOn` so an
 * uninstall can never strand a dependent package.
 */
import { readdir, readFile, stat, copyFile, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { validateIr, summarizeIr } from './ir.mjs';

const SUFFIX = '.ir.json';

async function listDir(dir) {
  try {
    const names = await readdir(dir);
    return names.filter((n) => n.endsWith(SUFFIX)).sort();
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
}

async function readPackage(dir, file) {
  const full = path.join(dir, file);
  try {
    const text = await readFile(full, 'utf8');
    const ir = JSON.parse(text);
    const { ok, problems } = validateIr(ir);
    return { file, path: full, ir, ok, problems, summary: summarizeIr(ir) };
  } catch (error) {
    return { file, path: full, ir: null, ok: false, problems: [{ path: '$', code: 'unreadable', message: error.message }], summary: null };
  }
}

/** Packages available in the catalog, annotated with whether they are installed. */
export async function catalogState(options) {
  const catalogFiles = await listDir(options.catalogDir);
  const installedFiles = await listDir(options.assetsDir);
  const installed = [];
  for (const file of installedFiles) installed.push(await readPackage(options.assetsDir, file));
  const installedIds = new Set(installed.filter((e) => e.ir).map((e) => e.ir.id));

  const available = [];
  for (const file of catalogFiles) {
    const entry = await readPackage(options.catalogDir, file);
    available.push(Object.assign({}, entry, entry.ir ? { installed: installedIds.has(entry.ir.id) } : {}));
  }
  const missingDeps = [];
  for (const entry of installed) {
    if (!entry.ir) continue;
    for (const dep of entry.ir.dependsOn || []) {
      if (!installedIds.has(dep)) missingDeps.push({ package: entry.ir.id, missing: dep });
    }
  }
  return { available, installed, installedIds, missingDeps };
}

/** Install one catalog package, refusing when a dependency is absent. */
export async function installAsset(options, packageId) {
  const state = await catalogState(options);
  const entry = state.available.find((e) => (e.ir ? e.ir.id === packageId : e.file === packageId));
  if (!entry) {
    return {
      ok: false,
      code: 'not-in-catalog',
      message: `资产市场里没有这个包：${packageId}`,
      available: state.available.filter((e) => e.ir).map((e) => e.ir.id),
    };
  }
  if (!entry.ir) {
    return { ok: false, code: 'invalid', message: `${entry.file} 无法解析或不合法`, problems: entry.problems };
  }
  if (!entry.ok) {
    return { ok: false, code: 'invalid', message: `${entry.ir.id} 未通过校验，不能安装`, problems: entry.problems };
  }
  if (state.installedIds.has(entry.ir.id)) {
    return { ok: false, code: 'already-installed', message: `${entry.ir.id} 已经安装`, version: entry.ir.version };
  }
  const missing = (entry.ir.dependsOn || []).filter((dep) => !state.installedIds.has(dep));
  if (missing.length) {
    return {
      ok: false,
      code: 'missing-dependency',
      message: `缺少依赖：${missing.join(', ')}（先安装它们）`,
      missing,
    };
  }

  await mkdir(options.assetsDir, { recursive: true });
  const target = path.join(options.assetsDir, entry.file);
  await copyFile(entry.path, target);
  return { ok: true, packageId: entry.ir.id, version: entry.ir.version, file: target };
}

/** Uninstall one package, refusing while another installed package needs it. */
export async function uninstallAsset(options, packageId) {
  const state = await catalogState(options);
  const entry = state.installed.find((e) => (e.ir ? e.ir.id === packageId : e.file === packageId));
  if (!entry) {
    return {
      ok: false,
      code: 'not-installed',
      message: `没有安装这个包：${packageId}`,
      installed: state.installed.filter((e) => e.ir).map((e) => e.ir.id),
    };
  }
  const dependents = state.installed.filter(
    (e) => e.ir && e.ir.id !== entry.ir.id && (e.ir.dependsOn || []).includes(entry.ir.id)
  );
  if (dependents.length) {
    return {
      ok: false,
      code: 'required-by',
      message: `${dependents.map((d) => d.ir.id).join(', ')} 依赖 ${entry.ir.id}，不能卸载`,
      requiredBy: dependents.map((d) => d.ir.id),
    };
  }
  await unlink(entry.path);
  return { ok: true, packageId: entry.ir.id, file: entry.path };
}

/** Whether a file exists (used by tests and diagnostics). */
export async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
