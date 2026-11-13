/**
 * Builds one repository's code graph on its own (the Repositories page's "Build code graph"), not as part of a session:
 * clones the latest commit into a temporary folder, runs graphify with a long time budget, and saves the graph where
 * sessions can download it (a presigned URL from the portal). The compact graph for the Code map goes back as the usual
 * `code-graph` event (see runner-graph.ts and server/code-map.ts).
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

export async function buildAndStoreGraph(
  repo: RunnerRepo,
  emit: (event: GraphEvent) => void,
  opts: { putUrl?: string; maxMs: number; bin?: string | null },
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

    progress('extract', 18, 'Starting graphify…', true);
    const result = await buildRepoGraph(repoDir, repo.name, emit, { bin, timeoutMs: opts.maxMs, onProgress: (p) => progress(p.stage, 18 + p.percent * 0.74, p.detail) });
    const graphFile = path.join(repoDir, GRAPH_DIR, 'graph.json');
    if (result !== 'built' || !fs.existsSync(graphFile)) {
      return fail(`graphify did not finish within ${Math.round(opts.maxMs / 60_000)} minutes`, commit);
    }

    const raw = fs.readFileSync(graphFile);
    let counts = { nodes: 0, links: 0 };
    try { counts = graphCounts(JSON.parse(raw.toString('utf8'))); } catch { /* the counts are only for display */ }
    const packed = zlib.gzipSync(raw, { level: 6 });
    if (packed.length > STORED_GRAPH_LIMITS.gzipBytes) {
      return { success: true, commit, ...counts, bytes: packed.length, stored: false, error: 'The graph is too large for sessions to load' };
    }
    if (!opts.putUrl) return { success: true, commit, ...counts, bytes: packed.length, stored: false };

    emit({ type: 'status', text: `Saving the code graph of ${repo.name} (${(packed.length / 1048576).toFixed(1)} MB)…` });
    progress('save', 92, `Saving the graph (${(packed.length / 1048576).toFixed(1)} MB)…`, true);
    const res = await fetch(opts.putUrl, {
      method: 'PUT',
      body: packed,
      headers: { 'content-length': String(packed.length) },
      signal: AbortSignal.timeout(5 * 60_000),
    });
    if (!res.ok) return { success: true, commit, ...counts, bytes: packed.length, stored: false, error: `The graph could not be saved (HTTP ${res.status})` };
    progress('save', 100, 'Done', true);
    return { success: true, commit, ...counts, bytes: packed.length, stored: true };
  } catch (e) {
    return fail(String((e as Error)?.message ?? e).slice(0, 300));
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* the machine's temp folder is cleared with it */ }
  }
}
