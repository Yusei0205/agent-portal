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

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const GRAPH_DIR = 'graphify-out';
/** The longest one repository may take, and the longest all of a run's repositories may take together. */
export const GRAPH_LIMITS = { repoMs: 150_000, totalMs: 240_000 } as const;

export type GraphResult = 'built' | 'skipped' | 'failed';

/** What the runner sends to the portal so people can search and view the graph (see server/code-map.ts). */
export type GraphEvent =
  | { type: 'status'; text: string }
  /** How far a stand-alone build has got, 0-100 over all its stages (see runner-graph-build.ts). */
  | { type: 'graph-progress'; repo: string; stage: 'clone' | 'extract' | 'build' | 'save'; percent: number; detail: string }
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
  return { PATH: process.env.PATH, HOME: home, TMPDIR: os.tmpdir(), LANG: 'C.UTF-8', PYTHONUTF8: '1', GRAPHIFY_BACKEND: 'none', GRAPHIFY_NO_UPDATE_CHECK: '1', PYTHONUNBUFFERED: '1' };
}

/** How far graphify has got: `percent` is 0-100 over its own work, `stage` what it is doing. */
export interface UpdateProgress { stage: 'extract' | 'build'; percent: number; detail: string }

/**
 * Reads one line of graphify's output into progress, or null when the line says nothing about it. graphify reports the code
 * extraction as "AST extraction: 200/542 uncached files (36%)"; the linking and grouping that follows reports nothing until it ends.
 * Exported for tests.
 */
export function parseGraphifyLine(line: string): UpdateProgress | null {
  const ext = /AST extraction:\s*(\d[\d,]*)\s*\/\s*(\d[\d,]*)/.exec(line);
  if (ext) {
    const done = Number(ext[1].replace(/,/g, ''));
    const total = Math.max(1, Number(ext[2].replace(/,/g, '')));
    if (done >= total) return { stage: 'build', percent: 70, detail: 'Linking the code and grouping it into communities…' };
    return { stage: 'extract', percent: 5 + Math.min(1, done / total) * 65, detail: `Reading the code: ${done.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} files` };
  }
  const cache = /AST cache:\s*\d[\d,]*\s*\/\s*\d[\d,]*.*?;\s*(\d[\d,]*) to extract/.exec(line);
  if (cache) return { stage: 'extract', percent: 5, detail: `Reading the code: ${cache[1]} files to read` };
  if (/Graph has [\d,]+ nodes|Building aggregated|graph\.html written/.test(line)) return { stage: 'build', percent: 90, detail: 'Writing the graph…' };
  if (/Rebuilt:|Code graph updated/.test(line)) return { stage: 'build', percent: 98, detail: 'Finishing…' };
  return null;
}

function runUpdate(bin: string, repoDir: string, timeoutMs: number, onProgress?: (p: UpdateProgress) => void): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const env = graphEnv();
    let out = '';
    let last: UpdateProgress = { stage: 'extract', percent: 2, detail: 'Starting graphify…' };
    let settled = false;
    let tail = '';
    const report = (p: UpdateProgress): void => {
      // Never goes backwards.
      last = { ...p, percent: Math.max(last.percent, p.percent) };
      onProgress?.(last);
    };
    const child = spawn(bin, ['update', '.'], { cwd: repoDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const feed = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      if (out.length < 2 * 1024 * 1024) out += text;
      const lines = (tail + text).split(/[\r\n]+/);
      tail = lines.pop() ?? '';
      for (const l of lines) { const p = parseGraphifyLine(l); if (p) report(p); }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    // graphify says nothing while it links and groups a large graph: creep towards the end so the bar keeps moving.
    const creep = onProgress ? setInterval(() => {
      if (last.stage === 'build' && last.percent < 97) report({ stage: 'build', percent: last.percent + (97 - last.percent) * 0.03, detail: last.detail });
      else if (last.stage === 'extract') onProgress(last);
    }, 3000) : null;
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ended already */ } }, timeoutMs);
    const done = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (creep) clearInterval(creep);
      try { fs.rmSync(String(env.HOME), { recursive: true, force: true }); } catch { /* ok */ }
      resolve({ code, out });
    };
    child.on('error', () => done(1));
    child.on('close', (code, signal) => done(signal ? 1 : code));
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
export const STORED_GRAPH_LIMITS = { gzipBytes: 64 * 1024 * 1024, rawBytes: 1024 * 1024 * 1024 } as const;

/** Unpacks a gzipped graph to `dest` without holding the unpacked text in memory (a big repository's graph is 300 MB+). Returns the unpacked size; throws when it is over `maxBytes` or is not JSON. */
export async function gunzipToFile(packed: Buffer, dest: string, maxBytes: number): Promise<number> {
  let size = 0;
  let first = true;
  const guard = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (first) { first = false; if (chunk[0] !== 0x7b) return cb(new Error('not a graph (it does not start with "{")')); }
      size += chunk.length;
      if (size > maxBytes) return cb(new Error(`unpacks to more than ${Math.round(maxBytes / 1048576)} MB`));
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.from([packed]), zlib.createGunzip(), guard, fs.createWriteStream(dest));
  } catch (err) {
    try { fs.rmSync(dest, { force: true }); } catch { /* best effort */ }
    throw err;
  }
  return size;
}

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
    excludeGraphFromGit(repoDir);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.part`;
    let size: number;
    try {
      size = await gunzipToFile(packed, tmp, STORED_GRAPH_LIMITS.rawBytes);
    } catch (err) {
      emit({ type: 'status', text: `The saved code graph of ${name} is not readable (${err instanceof Error ? err.message : String(err)}); the agent reads the code as usual.` });
      return;
    }
    fs.renameSync(tmp, file);
    fs.writeFileSync(path.join(dir, GRAPH_VERSION_FILE), graph.version);
    emit({ type: 'status', text: `Code graph of ${name} loaded (built ${graph.version.slice(0, 10)}, ${size >= 1048576 ? `${Math.round(size / 1048576)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`}): repos/${name}/${GRAPH_DIR}/` });
  } catch (err) {
    emit({ type: 'status', text: `The saved code graph of ${name} could not be loaded (${err instanceof Error ? err.message : String(err)}); the agent reads the code as usual.` });
  }
}

/** Builds (or updates, which is quick when little changed) the graph of one cloned repository. Never throws. */
export async function buildRepoGraph(
  repoDir: string,
  name: string,
  emit: Emit,
  opts: { bin?: string | null; timeoutMs?: number; onProgress?: (p: UpdateProgress) => void } = {},
): Promise<GraphResult> {
  const bin = opts.bin === undefined ? graphifyCommand() : opts.bin;
  if (!bin) return 'skipped';
  try {
    if (!fs.statSync(repoDir).isDirectory()) return 'skipped';
    excludeGraphFromGit(repoDir);
    const existed = fs.existsSync(path.join(repoDir, GRAPH_DIR, 'graph.json'));
    emit({ type: 'status', text: `${existed ? 'Updating' : 'Building'} the code graph of ${name}…` });
    const { code, out } = await runUpdate(bin, repoDir, opts.timeoutMs ?? GRAPH_LIMITS.repoMs, opts.onProgress);
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
