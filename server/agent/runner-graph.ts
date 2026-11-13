/**
 * A code knowledge graph of each cloned repository, built with graphify (https://pypi.org/project/graphifyy/) after the clone.
 *
 * Agents (Claude, Kiro and Codex alike) can then ask `graphify query "<question>"`, `graphify path "A" "B"` or
 * `graphify explain "X"` from inside the repository to find the right files and functions, instead of grepping and
 * reading whole files. Only code is parsed (tree-sitter, local, no model, no network, no key).
 *
 * It is switched on by the image: when the `graphify` command is not installed, or PORTAL_GRAPHIFY=0, nothing happens and the
 * run goes on exactly as before. A build that fails or takes too long is reported and skipped; it never fails a run.
 *
 * The output (`graphify-out/`) is written inside the repository, so it is added to the clone's own `.git/info/exclude`: it
 * never shows in `git status`, so an agent cannot commit it into someone's pull request.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

export const GRAPH_DIR = 'graphify-out';
/** The longest one repository may take, and the longest all of a run's repositories may take together. */
export const GRAPH_LIMITS = { repoMs: 150_000, totalMs: 240_000 } as const;

export type GraphResult = 'built' | 'skipped' | 'failed';

/** What the runner sends to the portal so people can search and view the graph (see server/code-map.ts). */
export type GraphEvent =
  | { type: 'status'; text: string }
  | { type: 'code-graph'; repo: string; encoding: 'gzip-base64'; data: string; nodes: number; links: number; truncated: boolean };
type Emit = (event: GraphEvent) => void;

/** The most items kept per repository; a larger graph keeps its best-connected items so the page stays fast. */
export const GRAPH_SEND_LIMITS = { nodes: 4000, links: 24000 } as const;

export interface CompactNode { i: string; l: string; f: string; n: number | null; c: number; k: 'function' | 'class' | 'file' | 'external' | 'other' }
export interface CompactGraph { nodes: CompactNode[]; links: { s: string; t: string; r: string }[]; communities: Record<string, string>; truncated: boolean }

/** graphify's graph.json reduced to what the Code map needs (names, files, lines, communities, relations). Exported for tests. */
export function compactGraph(raw: unknown, limits: { nodes: number; links: number } = GRAPH_SEND_LIMITS): CompactGraph | null {
  const g = (raw ?? {}) as { nodes?: unknown; links?: unknown; edges?: unknown };
  const rawNodes = Array.isArray(g.nodes) ? g.nodes as Record<string, any>[] : null;
  const rawLinks = (Array.isArray(g.links) ? g.links : Array.isArray(g.edges) ? g.edges : []) as Record<string, any>[];
  if (!rawNodes) return null;
  const kindOf = (n: Record<string, any>): CompactNode['k'] =>
    n.external || n.type === 'external' ? 'external' : n._callable_class ? 'class' : n._callable ? 'function'
      : /\.[A-Za-z0-9]{1,6}$/.test(String(n.label ?? '')) ? 'file' : 'other';
  let nodes: CompactNode[] = [];
  const communities: Record<string, string> = {};
  for (const n of rawNodes) {
    if (typeof n?.id !== 'string' || !n.id) continue;
    const c = typeof n.community === 'number' ? n.community : 0;
    if (typeof n.community_name === 'string' && !(String(c) in communities)) communities[String(c)] = n.community_name.slice(0, 80);
    const line = /^L(\d+)/.exec(String(n.source_location ?? ''));
    nodes.push({ i: n.id, l: String(n.label ?? n.id).slice(0, 120), f: String(n.source_file ?? '').slice(0, 240), n: line ? Number(line[1]) : null, c, k: kindOf(n) });
  }
  const ids = new Set(nodes.map((n) => n.i));
  let links = rawLinks.filter((e) => typeof e?.source === 'string' && typeof e?.target === 'string' && ids.has(e.source) && ids.has(e.target))
    .map((e) => ({ s: e.source as string, t: e.target as string, r: String(e.relation ?? 'related').slice(0, 24) }));
  let truncated = false;
  if (nodes.length > limits.nodes) {
    const degree = new Map<string, number>();
    for (const e of links) { degree.set(e.s, (degree.get(e.s) ?? 0) + 1); degree.set(e.t, (degree.get(e.t) ?? 0) + 1); }
    nodes = nodes.sort((a, b) => (a.k === 'external' ? 1 : 0) - (b.k === 'external' ? 1 : 0) || (degree.get(b.i) ?? 0) - (degree.get(a.i) ?? 0)).slice(0, limits.nodes);
    const keep = new Set(nodes.map((n) => n.i));
    links = links.filter((e) => keep.has(e.s) && keep.has(e.t));
    truncated = true;
  }
  if (links.length > limits.links) { links = links.slice(0, limits.links); truncated = true; }
  return { nodes, links, communities, truncated };
}

/** The compact graph as one gzip + base64 string (a graph compresses about eight to one). */
export function encodeGraph(graph: CompactGraph): string {
  return zlib.gzipSync(Buffer.from(JSON.stringify(graph), 'utf8')).toString('base64');
}

/** The graphify command to use, or null when it is not installed or switched off. */
export function graphifyCommand(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.PORTAL_GRAPHIFY === '0') return null;
  if (env.PORTAL_GRAPHIFY_BIN) return fs.existsSync(env.PORTAL_GRAPHIFY_BIN) ? env.PORTAL_GRAPHIFY_BIN : null;
  const names = process.platform === 'win32' ? ['graphify.exe', 'graphify.cmd'] : ['graphify'];
  for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) if (fs.existsSync(path.join(dir, n))) return path.join(dir, n);
  }
  return null;
}

/** Keeps the graph out of `git status` for this clone only (the repository's own files are not touched). */
export function excludeGraphFromGit(repoDir: string): void {
  try {
    const gitDir = path.join(repoDir, '.git');
    if (!fs.statSync(gitDir).isDirectory()) return;
    const file = path.join(gitDir, 'info', 'exclude');
    const line = `${GRAPH_DIR}/`;
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (current.split(/\r?\n/).includes(line)) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`);
  } catch { /* the graph then shows as an untracked folder; harmless */ }
}

/** Only what graphify needs: it is a third-party program, so the runner's own variables (tokens, keys) are not passed on. */
function graphEnv(): NodeJS.ProcessEnv {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'graphify-home-'));
  return { PATH: process.env.PATH, HOME: home, TMPDIR: os.tmpdir(), LANG: 'C.UTF-8', PYTHONUTF8: '1', GRAPHIFY_BACKEND: 'none', GRAPHIFY_NO_UPDATE_CHECK: '1' };
}

function runUpdate(bin: string, repoDir: string, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const env = graphEnv();
    const done = (code: number | null, out: string): void => {
      try { fs.rmSync(String(env.HOME), { recursive: true, force: true }); } catch { /* ok */ }
      resolve({ code, out });
    };
    execFile(bin, ['update', '.'], { cwd: repoDir, env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => done(err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, `${stdout}\n${stderr}`));
  });
}

/** The commit a clone is at ('' when it cannot be read). */
export function headCommit(repoDir: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', ['-c', `safe.directory=${repoDir}`, 'rev-parse', 'HEAD'], { cwd: repoDir, timeout: 10_000, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout).trim()));
  });
}

const GRAPH_VERSION_FILE = '.portal-graph-version';
/** The largest saved graph a session downloads (as gzip) and unpacks. */
export const STORED_GRAPH_LIMITS = { gzipBytes: 64 * 1024 * 1024, rawBytes: 256 * 1024 * 1024 } as const;

/**
 * Puts the repository's saved code graph (built from the Repositories page) at `graphify-out/graph.json`, so the agent can
 * query it. Nothing is built here. Skipped when that version is already in place. Never throws: without a graph the agent
 * reads the code as usual.
 */
export async function loadStoredGraph(repoDir: string, name: string, graph: { url: string; version: string }, emit: Emit): Promise<void> {
  try {
    if (!fs.statSync(repoDir).isDirectory()) return;
    const dir = path.join(repoDir, GRAPH_DIR);
    const file = path.join(dir, 'graph.json');
    try { if (fs.existsSync(file) && fs.readFileSync(path.join(dir, GRAPH_VERSION_FILE), 'utf8').trim() === graph.version) return; } catch { /* load it */ }
    const res = await fetch(graph.url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) { emit({ type: 'status', text: `The saved code graph of ${name} could not be loaded (HTTP ${res.status}); the agent reads the code as usual.` }); return; }
    if (Number(res.headers.get('content-length') ?? 0) > STORED_GRAPH_LIMITS.gzipBytes) { emit({ type: 'status', text: `The saved code graph of ${name} is too large to load; the agent reads the code as usual.` }); return; }
    const packed = Buffer.from(await res.arrayBuffer());
    if (packed.length > STORED_GRAPH_LIMITS.gzipBytes) { emit({ type: 'status', text: `The saved code graph of ${name} is too large to load; the agent reads the code as usual.` }); return; }
    const raw = zlib.gunzipSync(packed, { maxOutputLength: STORED_GRAPH_LIMITS.rawBytes });
    if (raw[0] !== 0x7b) { emit({ type: 'status', text: `The saved code graph of ${name} is not readable; the agent reads the code as usual.` }); return; }
    excludeGraphFromGit(repoDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, raw);
    fs.writeFileSync(path.join(dir, GRAPH_VERSION_FILE), graph.version);
    emit({ type: 'status', text: `Code graph of ${name} loaded (built ${graph.version.slice(0, 10)}): repos/${name}/${GRAPH_DIR}/` });
  } catch {
    emit({ type: 'status', text: `The saved code graph of ${name} could not be loaded; the agent reads the code as usual.` });
  }
}

/** Builds (or updates, which is quick when little changed) the graph of one cloned repository. Never throws. */
export async function buildRepoGraph(
  repoDir: string,
  name: string,
  emit: Emit,
  opts: { bin?: string | null; timeoutMs?: number } = {},
): Promise<GraphResult> {
  const bin = opts.bin === undefined ? graphifyCommand() : opts.bin;
  if (!bin) return 'skipped';
  try {
    if (!fs.statSync(repoDir).isDirectory()) return 'skipped';
    excludeGraphFromGit(repoDir);
    const existed = fs.existsSync(path.join(repoDir, GRAPH_DIR, 'graph.json'));
    emit({ type: 'status', text: `${existed ? 'Updating' : 'Building'} the code graph of ${name}…` });
    const { code, out } = await runUpdate(bin, repoDir, opts.timeoutMs ?? GRAPH_LIMITS.repoMs);
    if (code !== 0 || !fs.existsSync(path.join(repoDir, GRAPH_DIR, 'graph.json'))) {
      emit({ type: 'status', text: `No code graph for ${name} (graphify did not finish); the agent reads the code as usual.` });
      return 'failed';
    }
    const m = /(\d[\d,]*) nodes, (\d[\d,]*) edges/.exec(out);
    emit({ type: 'status', text: `Code graph of ${name} ready${m ? ` (${m[1]} nodes, ${m[2]} edges)` : ''}: repos/${name}/${GRAPH_DIR}/` });
    try {
      const compact = compactGraph(JSON.parse(fs.readFileSync(path.join(repoDir, GRAPH_DIR, 'graph.json'), 'utf8')));
      if (compact && compact.nodes.length > 0) emit({ type: 'code-graph', repo: name, encoding: 'gzip-base64', data: encodeGraph(compact), nodes: compact.nodes.length, links: compact.links.length, truncated: compact.truncated });
    } catch { /* the agent still has the graph; only the portal's Code map misses it */ }
    return 'built';
  } catch {
    return 'failed';
  }
}

/** Builds the graphs of the repositories that were cloned, one after another within an overall time budget. */
export async function buildRepoGraphs(
  reposDir: string,
  names: string[],
  emit: Emit,
  opts: { bin?: string | null } = {},
): Promise<void> {
  const bin = opts.bin === undefined ? graphifyCommand() : opts.bin;
  if (!bin) return;
  const deadline = Date.now() + GRAPH_LIMITS.totalMs;
  for (const name of names) {
    const left = deadline - Date.now();
    if (left < 10_000) { emit({ type: 'status', text: `Code graph of ${name} skipped: the time for building graphs ran out.` }); continue; }
    await buildRepoGraph(path.join(reposDir, name), name, emit, { bin, timeoutMs: Math.min(GRAPH_LIMITS.repoMs, left) });
  }
}
