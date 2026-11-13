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

export const GRAPH_DIR = 'graphify-out';
/** The longest one repository may take, and the longest all of a run's repositories may take together. */
export const GRAPH_LIMITS = { repoMs: 150_000, totalMs: 240_000 } as const;

export type GraphResult = 'built' | 'skipped' | 'failed';

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

/** Builds (or updates, which is quick when little changed) the graph of one cloned repository. Never throws. */
export async function buildRepoGraph(
  repoDir: string,
  name: string,
  emit: (event: { type: 'status'; text: string }) => void,
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
    return 'built';
  } catch {
    return 'failed';
  }
}

/** Builds the graphs of the repositories that were cloned, one after another within an overall time budget. */
export async function buildRepoGraphs(
  reposDir: string,
  names: string[],
  emit: (event: { type: 'status'; text: string }) => void,
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
