/**
 * What a runner does for the "open a pull request" feature (contracts A, B and C in
 * docs/superpowers/plans/2026-11-05-auto-pr-contracts.md), shared by the Claude runner and the Kiro runner:
 *   - reportRepoChanges: at the end of a run, say which cloned repositories have changes (read-only);
 *   - validateFinalizeRequest / runFinalize: the separate "finalize" invocation that pushes one new branch.
 * The git work itself lives in runner-finalize.ts (detectChanges, pushBranch).
 *
 * Free of any engine: where the work folder is comes in from the caller (the Claude runner keys it by session, the
 * Kiro runner uses its warm session's folder). Copied into each runner's shared/ folder next to runner-finalize.ts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { classifyPushError, detectChanges, pushBranch } from './runner-finalize.ts';
import type { PushErrorCode } from './runner-finalize.ts';
import { parseRunnerRepos } from './runner-repos.ts';
import { parseSnapshot, restoreWorkspace } from './runner-snapshot.ts';

type Emit = (event: Record<string, unknown>) => void;

function invalid(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

// ── Finalize request (mode "finalize") ───────────────────────────────────────

/** Push one new branch for a repository the session changed. See docs/superpowers/plans/2026-11-05-auto-pr-contracts.md, C. */
export interface FinalizeRequest {
  repo: string;
  base: string;
  branch: string;
  message: string;
  protectedBranches: string[];
  defaultBranch?: string;
  identity?: { name: string; email: string };
  /** The repository's git settings (same rules as the `env` of a repo in a run's `repos`). */
  env?: Record<string, string>;
  snapshot?: unknown;
}

export type FinalizeValidation = { ok: true; request: FinalizeRequest } | { ok: false; error: string };

const FINALIZE_FIELDS = new Set(['mode', 'repo', 'base', 'branch', 'message', 'protectedBranches', 'defaultBranch', 'identity', 'env', 'snapshot']);
const REPO_FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Same pattern as a repository's branch in shared/runner-repos.ts (parseRunnerRepos). */
const REPO_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
/** Same rules as the env of a repository in shared/runner-repos.ts: git settings only, http.* options or an empty credential.helper. */
const GIT_ENV_KEY = /^(GIT_TERMINAL_PROMPT|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d{1,2}|GIT_CONFIG_VALUE_\d{1,2})$/;
const MAX_PROTECTED = 50;
const MAX_PROTECTED_LEN = 200;
const MAX_FINALIZE_MESSAGE = 2_000;

function validGitEnv(raw: unknown): Record<string, string> | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return '"env" must be an object';
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 24) return '"env" has too many entries';
  const env: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (!GIT_ENV_KEY.test(k)) return `"env" may only hold git settings (got "${k}")`;
    if (typeof v !== 'string' || v.length > 8_000) return `"env" "${k}" must be a string`;
    env[k] = v;
  }
  for (const [k, v] of Object.entries(env)) {
    const m = /^GIT_CONFIG_KEY_(\d{1,2})$/.exec(k);
    if (!m) continue;
    const isHttp = /^http\./i.test(v);
    const isEmptyHelper = v === 'credential.helper' && env[`GIT_CONFIG_VALUE_${m[1]}`] === '';
    if (!isHttp && !isEmptyHelper) return '"env" may only set http.* git options';
  }
  return env;
}

function shortLine(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\r\n\0]/.test(v);
}

export function validateFinalizeRequest(raw: unknown): FinalizeValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return invalid('Payload must be a JSON object');
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!FINALIZE_FIELDS.has(key)) return invalid(`Unknown field: "${key}"`);
  }
  if (obj.mode !== 'finalize') return invalid('"mode" must be "finalize"');
  if (typeof obj.repo !== 'string' || !REPO_FOLDER.test(obj.repo) || obj.repo.length > 100 || obj.repo.includes('..')) {
    return invalid('"repo" must be a repository folder name');
  }
  for (const f of ['base', 'branch'] as const) {
    const v = obj[f];
    if (typeof v !== 'string' || !REPO_BRANCH.test(v) || v.includes('..')) return invalid(`"${f}" is not a valid branch name`);
  }
  if (typeof obj.message !== 'string' || !obj.message.trim() || obj.message.length > MAX_FINALIZE_MESSAGE || obj.message.includes('\0')) {
    return invalid(`"message" must be a non-empty string of at most ${MAX_FINALIZE_MESSAGE} characters`);
  }
  let protectedBranches: string[] = [];
  if (obj.protectedBranches !== undefined) {
    const p = obj.protectedBranches;
    if (!Array.isArray(p) || p.length > MAX_PROTECTED || p.some((x) => typeof x !== 'string' || x.length > MAX_PROTECTED_LEN)) {
      return invalid(`"protectedBranches" must be an array of at most ${MAX_PROTECTED} strings of at most ${MAX_PROTECTED_LEN} characters`);
    }
    protectedBranches = p as string[];
  }
  let defaultBranch: string | undefined;
  if (obj.defaultBranch !== undefined) {
    const d = obj.defaultBranch;
    if (typeof d !== 'string' || !REPO_BRANCH.test(d) || d.includes('..')) return invalid('"defaultBranch" is not a valid branch name');
    defaultBranch = d;
  }
  let identity: { name: string; email: string } | undefined;
  if (obj.identity !== undefined) {
    const i = obj.identity;
    if (typeof i !== 'object' || i === null || Array.isArray(i)) return invalid('"identity" must be an object');
    const o = i as Record<string, unknown>;
    for (const key of Object.keys(o)) {
      if (key !== 'name' && key !== 'email') return invalid(`Unknown field in "identity": "${key}"`);
    }
    if (!shortLine(o.name, 200)) return invalid('"identity.name" must be a short string');
    if (!shortLine(o.email, 200)) return invalid('"identity.email" must be a short string');
    identity = { name: o.name.trim(), email: o.email.trim() };
  }
  let env: Record<string, string> | undefined;
  if (obj.env !== undefined) {
    const e = validGitEnv(obj.env);
    if (typeof e === 'string') return invalid(e);
    env = e;
  }
  return {
    ok: true,
    request: {
      repo: obj.repo,
      base: obj.base as string,
      branch: obj.branch as string,
      message: obj.message,
      protectedBranches,
      ...(defaultBranch ? { defaultBranch } : {}),
      ...(identity ? { identity } : {}),
      ...(env ? { env } : {}),
      ...(obj.snapshot ? { snapshot: obj.snapshot } : {}),
    },
  };
}

/** Shown to people when the saved files cannot be brought back (contract G). */
export const WORKSPACE_GONE = "The session's saved files could not be restored, so nothing was pushed.";

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
function findRepoDir(workDir: string | null, persist: string | null, name: string): string | null {
  for (const root of [workDir ? path.join(workDir, 'repos') : null, persist ? path.join(persist, 'repos') : null]) {
    if (!root) continue;
    const dir = path.join(root, name);
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
  }
  return null;
}

/** Where this runner keeps the session's repositories: the live work folder (if any) and the persistent workspace. */
export interface FinalizeWhere {
  /** The folder holding `repos/` for the session right now, or null when this machine has none. */
  workDir: string | null;
  /** The persistent workspace root (also where a saved workspace is restored to), or null when there is none. */
  persist: string | null;
}

/**
 * Contract C: restore the saved workspace when the repository is not on this machine, push one new branch, and emit
 * `repo-pushed` with the commit or an error. Never throws; errors carry no credentials.
 */
export async function runFinalize(req: FinalizeRequest, where: FinalizeWhere, emit: Emit): Promise<void> {
  const env = req.env ?? {};
  const fail = (error: string, errorCode?: PushErrorCode): void => {
    const clean = scrub(error, env).slice(0, 500);
    emit({ type: 'repo-pushed', repo: req.repo, branch: req.branch, error: clean, errorCode: errorCode ?? classifyPushError(clean) });
  };
  try {
    const { workDir, persist } = where;
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
