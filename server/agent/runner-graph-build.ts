/**
 * Builds one repository's code graph on its own (the Repositories page's "Build code graph"), not as part of a session:
 * clones the latest commit into a temporary folder, runs graphify with a long time budget, and saves the graph where
 * sessions can download it (a presigned URL from the portal). The compact graph for the Code map goes back as the usual
 * `code-graph` event (see runner-graph.ts and server/code-map.ts).
 *
 * Folders and files that are not worth mapping (vendored code, build output, generated files) can be left out: the paths in
 * `exclude` are deleted from the temporary clone before graphify runs, so they are neither in the graph nor in the Code map.
 * (The clone is thrown away afterwards; the repository itself is never touched.)
 *
 * Runs on the Kiro runner (graphify is in its image). No Kiro sign-in is needed.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { cloneRunnerRepos, type RunnerRepo } from './runner-repos.ts';
import { buildRepoGraph, graphifyCommand, headCommit, GRAPH_DIR, STORED_GRAPH_LIMITS, type GraphEvent } from './runner-graph.ts';

export interface GraphBuildResult {
  /** The folders that hold the most items in the graph (two levels deep), largest first: what to leave out when a graph is too big. */
  folders?: { path: string; nodes: number }[];
  /** What the exclude patterns removed from the clone. */
  excluded?: { dirs: number; files: number };
  success: boolean;
  commit: string;
  nodes: number;
  links: number;
  /** Size of the saved (gzip) graph. */
  bytes: number;
  /** True when the full graph was saved for sessions to download. */
  stored: boolean;
  error?: string;
}

/** The graph's node and link counts, read from graphify's graph.json (it names the links `links` or `edges`). */
export function graphCounts(json: unknown): { nodes: number; links: number } {
  const g = (json ?? {}) as { nodes?: unknown; links?: unknown; edges?: unknown };
  const len = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
  return { nodes: len(g.nodes), links: len(g.links) || len(g.edges) };
}

// ── Leaving paths out ─────────────────────────────────────────────────────────

export const EXCLUDE_LIMITS = { patterns: 100, length: 200 } as const;

/**
 * Checks a list of exclude patterns (one folder or file per entry) and cleans it: trimmed, `\` as `/`, blank and `#` lines
 * dropped, duplicates removed. A pattern is written like a .gitignore line: `node_modules/` (a folder, at any depth),
 * `src/legacy/` (only that path), `*.min.js` (files by name), `**` crosses folders.
 */
export function parseExcludes(raw: unknown): { ok: true; patterns: string[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, patterns: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'The exclude list must be a list of paths' };
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return { ok: false, error: 'Each entry in the exclude list must be text' };
    const p = item.trim().replace(/\\/g, '/');
    if (!p || p.startsWith('#')) continue;
    if (p.length > EXCLUDE_LIMITS.length) return { ok: false, error: `An entry is longer than ${EXCLUDE_LIMITS.length} characters` };
    if (/[\u0000-\u001f]/.test(p)) return { ok: false, error: 'An entry has an unreadable character' };
    if (p.split('/').includes('..')) return { ok: false, error: `"${p}" cannot contain ..` };
    if (/^[./*]+$/.test(p)) return { ok: false, error: `"${p}" would leave out everything` };
    if (!out.includes(p)) out.push(p);
  }
  if (out.length > EXCLUDE_LIMITS.patterns) return { ok: false, error: `At most ${EXCLUDE_LIMITS.patterns} entries` };
  return { ok: true, patterns: out };
}

interface Compiled { re: RegExp; dirOnly: boolean; anchored: boolean }

function compileExclude(pattern: string): Compiled {
  let p = pattern;
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.replace(/\/+$/, '');
  const anchored = p.includes('/');
  p = p.replace(/^\/+/, '');
  let src = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        // `**/` is any folders (or none); a bare `**` is anything.
        if (p[i + 2] === '/') { src += '(?:.*/)?'; i += 2; } else { src += '.*'; i += 1; }
      } else src += '[^/]*';
    } else if (c === '?') src += '[^/]';
    else src += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return { re: new RegExp(`^${src}$`), dirOnly, anchored };
}

/** Whether a path (relative to the repository, with `/`) is left out by any of the patterns. Exported for tests. */
export function isExcluded(rel: string, isDir: boolean, patterns: string[]): boolean {
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  return patterns.map(compileExclude).some((c) => (!c.dirOnly || isDir) && c.re.test(c.anchored ? rel : name));
}

/** Deletes everything the patterns match from a clone (never `.git`). Returns what was removed. */
export function pruneExcluded(root: string, patterns: string[]): { dirs: number; files: number } {
  const compiled = patterns.map(compileExclude);
  const removed = { dirs: 0, files: 0 };
  const walk = (dir: string, relDir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.name === '.git') continue;
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      const isDir = ent.isDirectory();
      if (compiled.some((c) => (!c.dirOnly || isDir) && c.re.test(c.anchored ? rel : ent.name))) {
        try { fs.rmSync(path.join(dir, ent.name), { recursive: true, force: true }); } catch { continue; }
        if (isDir) removed.dirs++; else removed.files++;
        continue;
      }
      if (isDir) walk(path.join(dir, ent.name), rel);
    }
  };
  walk(root, '');
  return removed;
}

/** The folders with the most items in a graph (by each item's source file), `depth` levels deep, largest first. */
export function topFolders(json: unknown, depth = 2, limit = 12): { path: string; nodes: number }[] {
  const nodes = (json as { nodes?: unknown })?.nodes;
  if (!Array.isArray(nodes)) return [];
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const f = (n as { source_file?: unknown })?.source_file;
    if (typeof f !== 'string' || !f.includes('/')) continue;
    const segs = f.replace(/\\/g, '/').replace(/^\.?\//, '').split('/');
    const folder = segs.slice(0, Math.min(depth, segs.length - 1)).join('/');
    if (folder) counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([p, c]) => ({ path: p, nodes: c }));
}

export async function buildAndStoreGraph(
  repo: RunnerRepo,
  emit: (event: GraphEvent) => void,
  opts: { putUrl?: string; maxMs: number; bin?: string | null; exclude?: string[] },
): Promise<GraphBuildResult> {
  const fail = (error: string, commit = ''): GraphBuildResult => ({ success: false, commit, nodes: 0, links: 0, bytes: 0, stored: false, error });
  const bin = opts.bin === undefined ? graphifyCommand() : opts.bin;
  if (!bin) return fail('graphify is not installed on this runner');

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-build-'));
  try {
    const { graph: _saved, ...plain } = repo;
    void _saved;
    // One bar over every stage: cloning 0-18%, graphify 18-92%, saving 92-100%. It never goes backwards.
    let overall = 0;
    let lastEmit = 0;
    const progress = (stage: 'clone' | 'extract' | 'build' | 'save', pct: number, detail: string, force = false): void => {
      overall = Math.max(overall, Math.min(100, pct));
      const t = Date.now();
      if (!force && t - lastEmit < 1000) return;
      lastEmit = t;
      emit({ type: 'graph-progress', repo: repo.name, stage, percent: Math.round(overall * 10) / 10, detail });
    };
    progress('clone', 0, 'Cloning the repository…', true);
    const names = await cloneRunnerRepos([plain], work, emit, {
      shallow: true,
      onProgress: (u) => progress('clone', (Number(u.percent) || 0) * 0.18, `Cloning: ${u.phase}${u.detail ? ` · ${u.detail}` : ''}`),
    });
    if (names.length === 0) return fail('The repository could not be cloned');
    const repoDir = path.join(work, 'repos', repo.name);
    const commit = await headCommit(repoDir);

    let excluded: { dirs: number; files: number } | undefined;
    if (opts.exclude?.length) {
      progress('extract', 17, `Leaving out ${opts.exclude.length} excluded ${opts.exclude.length === 1 ? 'path' : 'paths'}…`, true);
      excluded = pruneExcluded(repoDir, opts.exclude);
      emit({ type: 'status', text: `Left out ${excluded.dirs} folders and ${excluded.files} files that match the exclude list.` });
    }

    progress('extract', 18, 'Starting graphify…', true);
    const result = await buildRepoGraph(repoDir, repo.name, emit, { bin, timeoutMs: opts.maxMs, onProgress: (p) => progress(p.stage, 18 + p.percent * 0.74, p.detail) });
    const graphFile = path.join(repoDir, GRAPH_DIR, 'graph.json');
    if (result !== 'built' || !fs.existsSync(graphFile)) {
      return fail(`graphify did not finish within ${Math.round(opts.maxMs / 60_000)} minutes`, commit);
    }

    const raw = fs.readFileSync(graphFile);
    let counts = { nodes: 0, links: 0 };
    let folders: { path: string; nodes: number }[] = [];
    try {
      const parsed = JSON.parse(raw.toString('utf8')) as unknown;
      counts = graphCounts(parsed);
      folders = topFolders(parsed);
    } catch { /* the counts and folders are only for display */ }
    const extra = { ...(folders.length ? { folders } : {}), ...(excluded ? { excluded } : {}) };
    const packed = zlib.gzipSync(raw, { level: 6 });
    if (packed.length > STORED_GRAPH_LIMITS.gzipBytes) {
      return { success: true, commit, ...counts, ...extra, bytes: packed.length, stored: false, error: 'The graph is too large for sessions to load' };
    }
    if (!opts.putUrl) return { success: true, commit, ...counts, ...extra, bytes: packed.length, stored: false };

    emit({ type: 'status', text: `Saving the code graph of ${repo.name} (${(packed.length / 1048576).toFixed(1)} MB)…` });
    progress('save', 92, `Saving the graph (${(packed.length / 1048576).toFixed(1)} MB)…`, true);
    const res = await fetch(opts.putUrl, {
      method: 'PUT',
      body: packed,
      headers: { 'content-length': String(packed.length) },
      signal: AbortSignal.timeout(5 * 60_000),
    });
    if (!res.ok) return { success: true, commit, ...counts, ...extra, bytes: packed.length, stored: false, error: `The graph could not be saved (HTTP ${res.status})` };
    progress('save', 100, 'Done', true);
    return { success: true, commit, ...counts, ...extra, bytes: packed.length, stored: true };
  } catch (e) {
    return fail(String((e as Error)?.message ?? e).slice(0, 300));
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* the machine's temp folder is cleared with it */ }
  }
}
