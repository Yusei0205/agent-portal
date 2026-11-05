/**
 * What the runner does for the "open a pull request" feature (contracts A, B and C in
 * docs/superpowers/plans/2026-11-05-auto-pr-contracts.md):
 *   - reportRepoChanges: at the end of a run, say which cloned repositories have changes (read-only);
 *   - runFinalize: the separate "finalize" invocation that pushes one new branch.
 * The git work itself lives in shared/runner-finalize.ts (detectChanges, pushBranch).
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { classifyPushError, detectChanges, pushBranch } from '../shared/runner-finalize.js';
import type { PushErrorCode } from '../shared/runner-finalize.js';
import { parseRunnerRepos, usablePersistRoot, PERSIST_ROOT } from '../shared/runner-repos.js';
import { parseSnapshot, restoreWorkspace } from '../shared/runner-snapshot.js';
import type { FinalizeRequest } from './validate.js';

type Emit = (event: Record<string, unknown>) => void;

/** Shown to people when the saved files cannot be brought back (contract G). */
export const WORKSPACE_GONE = "The session's saved files could not be restored, so nothing was pushed.";

/** The session's work folder, named the same way run.ts names it. */
export function workDirFor(sessionId: string | undefined, runId: string): string {
  const sessionKey = (sessionId ?? `run-${runId}`).replace(/[^A-Za-z0-9._-]/g, '_');
  const workRoot = process.env.AGENT_RUNNER_WORK_ROOT || path.join('/tmp', 'agent-sessions');
  return path.join(workRoot, sessionKey, 'work');
}

/**
 * git's own settings for one extra option, added after whatever the caller set. Used to trust the exact repository
 * folder (a mounted workspace reports another owner, and git then refuses to work in it).
 */
function withGitOption(env: Record<string, string>, key: string, value: string): Record<string, string> {
  const merged = { ...process.env, ...env } as Record<string, string | undefined>;
  const n = Number.parseInt(merged.GIT_CONFIG_COUNT ?? '0', 10) || 0;
  return { ...env, GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: key, [`GIT_CONFIG_VALUE_${n}`]: value };
}

function realDir(dir: string): string {
  try { return fs.realpathSync.native(dir); } catch { return dir; }
}

function gitText(cwd: string, args: string[], env: Record<string, string>): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' }, timeout: 30_000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim());
    });
  });
}

/** Strip the values of the git settings (the auth header) from text that may reach an event. */
function scrub(text: string, env: Record<string, string> = {}): string {
  let out = text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]*@/gi, '$1***@');
  for (const v of Object.values(env)) if (v.length >= 6) out = out.split(v).join('***');
  return out;
}

/**
 * Contract A/B: for each repository this run cloned, emit one `repo-changes` event when it has changes.
 * Read-only: nothing is committed or pushed. A repository that cannot be checked is skipped.
 */
export async function reportRepoChanges(reposRaw: unknown[] | undefined, workDir: string, emit: Emit): Promise<void> {
  const parsed = parseRunnerRepos(reposRaw);
  if (!parsed.ok) return;
  for (const repo of parsed.repos) {
    const dir = path.join(workDir, 'repos', repo.name);
    try {
      if (!fs.existsSync(path.join(dir, '.git'))) continue;
      const trusted = withGitOption(repo.env ?? {}, 'safe.directory', realDir(dir));
      let base = repo.branch;
      if (!base) {
        const head = await gitText(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], trusted);
        base = head ? head.replace(/^origin\//, '') : undefined;
      }
      if (!base) continue;
      // detectChanges has no env argument; its git calls read the process environment, so set the trust option there
      // for the duration of the call (one run at a time per machine).
      const keys = Object.keys(trusted).filter((k) => /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(k));
      const saved = keys.map((k) => [k, process.env[k]] as const);
      for (const k of keys) process.env[k] = trusted[k];
      let changes: { commits: number; files: number };
      try {
        changes = await detectChanges(dir, base);
      } finally {
        for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      }
      if (changes.commits > 0 || changes.files > 0) {
        emit({ type: 'repo-changes', repo: repo.name, base, commits: changes.commits, files: changes.files });
      }
    } catch {
      /* best effort: a repository that cannot be checked is reported as unchanged */
    }
  }
}

/** Where the repository's folder is: the work folder's link first, then the persistent workspace. */
function findRepoDir(workDir: string, persist: string | null, name: string): string | null {
  for (const root of [path.join(workDir, 'repos'), persist ? path.join(persist, 'repos') : null]) {
    if (!root) continue;
    const dir = path.join(root, name);
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
  }
  return null;
}

/**
 * Contract C: restore the saved workspace when the repository is not on this machine, push one new branch, and emit
 * `repo-pushed` with the commit or an error. Never throws; errors carry no credentials.
 */
export async function runFinalize(req: FinalizeRequest, sessionId: string | undefined, emit: Emit): Promise<void> {
  const env = req.env ?? {};
  const fail = (error: string, errorCode?: PushErrorCode): void => {
    const clean = scrub(error, env).slice(0, 500);
    emit({ type: 'repo-pushed', repo: req.repo, branch: req.branch, error: clean, errorCode: errorCode ?? classifyPushError(clean) });
  };
  try {
    const workDir = workDirFor(sessionId, `finalize-${req.repo}`);
    const persist = usablePersistRoot(PERSIST_ROOT);
    let dir = findRepoDir(workDir, persist, req.repo);
    if (!dir) {
      await restoreWorkspace(parseSnapshot(req.snapshot), persist, (ev) => emit(ev)).catch(() => false);
      dir = findRepoDir(workDir, persist, req.repo);
    }
    if (!dir) return fail(WORKSPACE_GONE, 'no-workspace');
    emit({ type: 'status', text: `Pushing ${req.branch} for ${req.repo}…` });
    const { sha } = await pushBranch({
      repoDir: dir,
      base: req.base,
      branch: req.branch,
      message: req.message,
      env: withGitOption(env, 'safe.directory', realDir(dir)),
      protectedPatterns: req.protectedBranches,
      defaultBranch: req.defaultBranch ?? null,
      ...(req.identity ? { identity: req.identity } : {}),
    });
    emit({ type: 'repo-pushed', repo: req.repo, branch: req.branch, sha });
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}
