/**
 * Finalize helpers for the runners (server/agent/runner-finalize.ts): find what a session changed in a repository,
 * pick a branch name, check protected branches, and push one new branch.
 *
 * Shared with the runner build (agent-runner/build.mjs copies it into shared/), so it imports only node: modules.
 * Every git call goes through execFile with an argument array (never a shell), and nothing here ever forces a push.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** One changed file: lines added and removed against the base (0 and 0 for a binary file). */
export interface ChangedPath { path: string; added: number; removed: number }

/**
 * `paths` is only sent by runners built with this file from Task 9 of the auto-fix work on; an older runner leaves it out, and the
 * portal must then treat the changed file list as unknown.
 */
export interface RepoChanges { repo: string; base: string; commits: number; files: number; paths?: ChangedPath[] }

/** At most this many paths are reported; one more than the portal's limit, so a longer list is still seen as too long. */
export const MAX_REPORTED_PATHS = 2001;
/** An untracked file larger than this is not read; it counts as this many added lines (enough to trip any line limit). */
const UNTRACKED_READ_MAX = 8 * 1024 * 1024;
const UNTRACKED_TOO_LARGE_LINES = 1_000_000;

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const GIT_TIMEOUT_MS = 120_000;

/** Lowercase `[a-z0-9-]`, runs collapsed, no leading or trailing dash, at most `max` characters. */
export function slugify(text: string, max = 40): string {
  const s = String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '');
  return s.slice(0, Math.max(0, max)).replace(/-+$/, '');
}

/** `portal/<KEY>-<slug>` or `portal/<slug>`; on a clash with `taken` append -2, -3, ... */
export type PushErrorCode = 'no-permission' | 'no-workspace' | 'failed' | 'protected-path';

/** Sorts a push failure into what the person should be told. Shared by the runner (which sends the code) and the portal (fallback). */
export function classifyPushError(text: string): PushErrorCode {
  if (/restore|snapshot|workspace|repos\/ (is )?missing|no such (file|directory)/i.test(text) && !/permission/i.test(text)) return 'no-workspace';
  if (/permission|denied|forbidden|\b40[13]\b|not authori[sz]ed|authentication|could not read username|access/i.test(text)) return 'no-permission';
  return 'failed';
}

/** `stem` (an auto-fix branch, already a valid name) replaces the `portal/...` name; the clash rule is the same. */
export function branchNameFor(opts: { ticketKey?: string | null; title: string; taken?: string[]; stem?: string }): string {
  const key = String(opts.ticketKey ?? '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const slug = slugify(opts.title) || 'changes';
  const stem = opts.stem || `portal/${key ? `${key}-` : ''}${slug}`;
  const taken = new Set(opts.taken ?? []);
  if (!taken.has(stem)) return stem;
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Exact names and `*` patterns (`release/*`). The default branch is always protected. Case-sensitive; `*` is any run of characters,
 * `/` included; every other character (`?` too) is literal. Matched by the same linear position-set matcher as protected paths
 * (matchTokens), so no pattern can make it slow.
 */
export function isProtectedBranch(name: string, patterns: string[], defaultBranch?: string | null): boolean {
  if (defaultBranch && name === defaultBranch) return true;
  const n = String(name);
  for (const raw of patterns) {
    const p = String(raw ?? '').trim();
    if (!p) continue;
    if (!p.includes('*')) {
      if (n === p) return true;
      continue;
    }
    const tokens: GlobToken[] = [];
    for (const c of p) {
      if (c === '*') { if (tokens.at(-1)?.t !== 'any') tokens.push({ t: 'any' }); } else tokens.push({ t: 'lit', c });
    }
    if (matchTokens(tokens, n)) return true;
  }
  return false;
}

/** Strip anything credential-like from text that may reach a log or an event. */
function redact(text: string, env: Record<string, string> = {}): string {
  let out = String(text).replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]*@/gi, '$1***@');
  for (const v of Object.values(env)) {
    if (typeof v === 'string' && v.length >= 6) out = out.split(v).join('***');
  }
  return out;
}

/**
 * Set on every git call of the change report, the checks before a push and the push: git must read the repository as it really is,
 * so replace objects (`git replace`) and grafts (which the agent can set up to show a clean commit while the real one is pushed) are
 * off, and neither the system-wide nor the global config (~/.gitconfig, $XDG_CONFIG_HOME/git/config) is read. The runners' own
 * settings (credentials, safe.directory) come through GIT_CONFIG_COUNT/KEY/VALUE and `-c`, never from those files.
 */
export const TRUSTED_GIT_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_GRAFT_FILE: '/nonexistent/agent-portal-no-grafts',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
});

/**
 * `-c` settings put in front of every runner git call. Command-line settings beat the repository's own `.git/config`, which the agent
 * can write, for the settings that run a program: hooks (core.hooksPath, so even the hooks `--no-verify` does not cover, such as
 * reference-transaction and post-commit, never run), core.fsmonitor, core.sshCommand, core.askPass, credential helpers,
 * core.alternateRefsCommand, signature display, automatic gc/maintenance (which can run hooks), and the `ext::` transport. Filter and
 * diff drivers cannot be switched off this way (their names are free); the check and the push therefore run in a private repository
 * that has no such configuration (see pushBranch), and diffs pass --no-ext-diff --no-textconv.
 */
export const SAFE_GIT_CONFIG: readonly string[] = Object.freeze([
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'core.untrackedCache=false',
  'core.sshCommand=false',
  'core.askPass=',
  'credential.helper=',
  'core.alternateRefsCommand=true',
  'log.showSignature=false',
  'gc.auto=0',
  'maintenance.auto=false',
  'protocol.ext.allow=never',
  'commit.gpgsign=false',
]);
const SAFE_GIT_ARGS: string[] = SAFE_GIT_CONFIG.flatMap((c) => ['-c', c]);

/** Variables of the runner's own environment that reach git; nothing else does (no GIT_*, no proxies, no ssh or askpass commands). */
const PASS_ENV = /^(PATH|HOME|LANG|LANGUAGE|LC_[A-Z_]+|TMPDIR|TZ)$/;
/** The request-supplied git settings (credentials as http.* options, safe.directory added by the runner). */
const REQUEST_GIT_ENV = /^(GIT_TERMINAL_PROMPT|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d{1,3}|GIT_CONFIG_VALUE_\d{1,3})$/;

/**
 * The environment of a runner git call, built from an allowlist instead of the runner's whole environment: PATH, HOME, locale and
 * TMPDIR from the process, the GIT_CONFIG_COUNT/KEY/VALUE settings and GIT_TERMINAL_PROMPT from `extra` (the request's git settings),
 * then TRUSTED_GIT_ENV. Anything else (GIT_DIR, GIT_SSH_COMMAND, GIT_EXTERNAL_DIFF, GIT_TRACE, GIT_CONFIG_PARAMETERS, ...) is dropped.
 */
export function gitProcessEnv(extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string' && PASS_ENV.test(k)) out[k] = v;
  for (const [k, v] of Object.entries(extra)) if (typeof v === 'string' && REQUEST_GIT_ENV.test(k)) out[k] = v;
  return { ...out, ...TRUSTED_GIT_ENV };
}

/** The git subcommand of an argument list (for error messages): the first argument after any `-c x` and `--git-dir x` pairs. */
function subcommandOf(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c' || args[i] === '--git-dir' || args[i] === '--work-tree' || args[i] === '-C') { i++; continue; }
    if (!args[i].startsWith('-')) return args[i];
  }
  return 'command';
}

/**
 * One runner git call: SAFE_GIT_ARGS first, the allowlisted environment, never a shell. `internal` holds variables the runner itself
 * sets for this call (GIT_INDEX_FILE), added after the allowlist.
 */
function runGit(
  cwd: string, args: string[], env: Record<string, string> = {}, allowFail = false, internal: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('git', [...SAFE_GIT_ARGS, ...args], {
      cwd,
      env: { ...gitProcessEnv(env), ...internal, ...TRUSTED_GIT_ENV },
      maxBuffer: 32 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      const out = String(stdout ?? '');
      const errText = String(stderr ?? '');
      if (!err) return resolve({ code: 0, stdout: out, stderr: errText });
      const code = typeof (err as { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : 1;
      if (allowFail) return resolve({ code, stdout: out, stderr: errText });
      const detail = redact(errText.trim() || (err as Error).message, env).slice(0, 500);
      reject(new Error(`git ${subcommandOf(args)} failed: ${detail}`));
    });
  });
}

/**
 * The changed paths from the portal's side of an event: a list of `{ path, added, removed }`, cut at MAX_REPORTED_PATHS, or
 * undefined when it is missing or malformed (an older runner, or a bad event), which means "unknown".
 */
export function parseChangedPaths(raw: unknown): ChangedPath[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ChangedPath[] = [];
  for (const item of raw.slice(0, MAX_REPORTED_PATHS)) {
    if (typeof item !== 'object' || item === null) return undefined;
    const { path: p, added, removed } = item as Record<string, unknown>;
    if (typeof p !== 'string' || !p) return undefined;
    const a = Number(added);
    const r = Number(removed);
    if (!Number.isFinite(a) || !Number.isFinite(r) || a < 0 || r < 0) return undefined;
    out.push({ path: p, added: a, removed: r });
  }
  return out;
}

/** The private ref the base branch is fetched into before paths are reported or a branch is pushed (not set up by the agent). */
export const PRIVATE_BASE_REF = 'refs/portal/base';
const PATH_CHECK_MAX = 1024;
const MAX_SCANNED_COMMITS = 200;
const MAX_SCANNED_PATHS = 20_000;

/**
 * For the change report only (the push is checked in a private repository, see pushBranch): fetch `base` into PRIVATE_BASE_REF of the
 * session's repository (forced, overwriting whatever is there) and return the merge base of it and HEAD, or null when either step
 * fails. The base comes from `remoteUrl` when the caller has one, else from the session's configured push URL (the agent can
 * change that; acceptable here because this list only decides whether a person is asked, and the push is checked separately). The session's remote-tracking refs are not trusted.
 */
async function trustedMergeBase(repoDir: string, base: string, env: Record<string, string>, remoteUrl?: string): Promise<string | null> {
  if (!BRANCH_RE.test(base) || base.includes('..')) return null;
  let remote = remoteUrl;
  if (!remote) {
    const url = await runGit(repoDir, ['remote', 'get-url', '--push', 'origin'], env, true);
    remote = url.code === 0 && url.stdout.trim() ? url.stdout.trim() : 'origin';
  }
  if (remote.startsWith('-')) return null;
  const fetched = await runGit(repoDir, ['fetch', '--no-tags', '--quiet', '--', remote, `+refs/heads/${base}:${PRIVATE_BASE_REF}`], env, true);
  if (fetched.code !== 0) return null;
  const mb = await runGit(repoDir, ['merge-base', PRIVATE_BASE_REF, 'HEAD'], env, true);
  const sha = mb.stdout.trim();
  return mb.code === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

/**
 * The one glob matcher for protected paths, used by the runner before a push and by the portal's guardrails (server/autofix/
 * guardrails.ts imports it), so the two cannot disagree. Supported: `*`, `**`, `?` and literal characters, nothing else (no braces,
 * no brackets: such a pattern is refused by the policy and, if already stored, fails closed, see protectedPatternProblem).
 *   `**` followed by `/`  zero or more directories;  any other `**`  anything, `/` included (so `dir/**` is every descendant);
 *   `*`  anything but `/`;  `?`  one character but `/`.
 * Names starting with a dot match like any other (dot files and dot-directories), matching is case-insensitive (both sides are
 * lowercased), and a newline is an ordinary character. It is not a regular expression: a set of reachable path positions is carried
 * through the pattern's tokens, so matching costs O(tokens x path length) whatever the pattern (no backtracking).
 */
export interface GlobMatcher { test(path: string): boolean }

type GlobToken = { t: 'lit'; c: string } | { t: 'one' } | { t: 'star' } | { t: 'any' } | { t: 'dirs' };

/** The pattern rules the matcher supports; null when `glob` is fine, else why it is not. */
export const MAX_PATTERN_CHARS = 200;
export const MAX_PATTERN_WILDCARD_RUNS = 6;
export function protectedPatternProblem(glob: string): string | null {
  const g = String(glob ?? '');
  if (!g.trim()) return 'is empty';
  if (/[{}[\]]/.test(g)) return 'uses { } [ or ]';
  if (g.length > MAX_PATTERN_CHARS) return `is longer than ${MAX_PATTERN_CHARS} characters`;
  const runs = (g.match(/[*?]+/g) ?? []).length;
  if (runs > MAX_PATTERN_WILDCARD_RUNS) return `has more than ${MAX_PATTERN_WILDCARD_RUNS} wildcard runs`;
  if (hasControlChar(g)) return 'contains a control character';
  return null;
}

function globTokens(glob: string): GlobToken[] {
  const g = normaliseRepoPath(String(glob)).toLowerCase();
  const out: GlobToken[] = [];
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      let j = i;
      while (g[j] === '*') j++;
      const atStart = i === 0 || g[i - 1] === '/';
      if (atStart && g[j] === '/') {
        i = j; // `**/`
        if (out.at(-1)?.t !== 'dirs') out.push({ t: 'dirs' }); // `**/**/` is the same as `**/`
        continue;
      }
      i = j - 1;
      if (out.at(-1)?.t !== 'any') out.push({ t: 'any' });
      continue;
    }
    if (c === '*') { if (out.at(-1)?.t !== 'star') out.push({ t: 'star' }); continue; }
    if (c === '?') { out.push({ t: 'one' }); continue; }
    out.push({ t: 'lit', c });
  }
  return out;
}

export function compileGlob(glob: string): GlobMatcher {
  const tokens = globTokens(glob);
  return { test: (pathIn: string): boolean => matchTokens(tokens, String(pathIn).toLowerCase()) };
}

/** Whether `tokens` match all of `s` (as given: callers lowercase both sides when matching is case-insensitive). Linear per token. */
function matchTokens(tokens: GlobToken[], s: string): boolean {
  const n = s.length;
  // cur[i]: the tokens so far can match s[0..i).
  let cur = new Uint8Array(n + 1);
  cur[0] = 1;
  for (const tok of tokens) {
    const next = new Uint8Array(n + 1);
    let any = false;
    switch (tok.t) {
      case 'lit':
        for (let i = 0; i < n; i++) if (cur[i] && s[i] === tok.c) { next[i + 1] = 1; any = true; }
        break;
      case 'one':
        for (let i = 0; i < n; i++) if (cur[i] && s[i] !== '/') { next[i + 1] = 1; any = true; }
        break;
      case 'star':
        for (let j = 0; j <= n; j++) {
          if (cur[j] || (j > 0 && next[j - 1] && s[j - 1] !== '/')) { next[j] = 1; any = true; }
        }
        break;
      case 'any':
        for (let j = 0; j <= n; j++) if (cur[j] || (j > 0 && next[j - 1])) { next[j] = 1; any = true; }
        break;
      case 'dirs': {
        // Zero directories, or any text ending in `/` after a reachable position.
        let seen = false;
        for (let j = 0; j <= n; j++) {
          if ((j > 0 && seen && s[j - 1] === '/') || cur[j]) { next[j] = 1; any = true; }
          if (cur[j]) seen = true;
        }
        break;
      }
    }
    if (!any) return false;
    cur = next;
  }
  return cur[n] === 1;
}

/** Forward slashes, single slashes, no leading `./` or `/` (the same for globs and paths). */
export function normaliseRepoPath(p: string): string {
  let n = String(p).replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  while (n.startsWith('./') || n.startsWith('/')) n = n.startsWith('./') ? n.slice(2) : n.slice(1);
  return n;
}

/** True when the path holds a control character (below 0x20, or 0x7f): refused outright by both checks. */
export function hasControlChar(p: string): boolean {
  return /[\x00-\x1f\x7f]/.test(p);
}

const compiled = new Map<string, GlobMatcher>();
/** Whether `file` matches `glob` under the rules of compileGlob (compiled matchers are cached). */
export function protectedGlobMatches(file: string, glob: string): boolean {
  let re = compiled.get(glob);
  if (!re) {
    re = compileGlob(glob);
    if (compiled.size > 1000) compiled.clear();
    compiled.set(glob, re);
  }
  return re.test(normaliseRepoPath(file).toLowerCase());
}

/** The first deny pattern `file` matches, or null. */
export function deniedBy(file: string, patterns: GlobMatcher[], sources: string[]): string | null {
  const n = normaliseRepoPath(file).toLowerCase();
  for (let i = 0; i < patterns.length; i++) if (patterns[i].test(n)) return sources[i];
  return null;
}

/**
 * Tests only: a function the tests may put on globalThis under this symbol runs after the checks and before the push (to move refs in
 * between). Nothing in the runners sets it, and it is not exported: when it is absent this is a no-op.
 */
const TEST_BEFORE_PUSH = Symbol.for('agent-portal.test.beforePush');
async function testBeforePush(repoDir: string, branch: string): Promise<void> {
  const fn = (globalThis as Record<symbol, unknown>)[TEST_BEFORE_PUSH];
  if (typeof fn === 'function') await (fn as (d: string, b: string) => Promise<void>)(repoDir, branch);
}

/** Raised by pushBranch when the branch would carry a denied path (or the check itself cannot be done). */
export class ProtectedPathError extends Error {
  code = 'protected-path' as const;
}

/** A `repo-changes` event as the portal keeps it; `paths` only when the runner sent a well-formed list. */
export function repoChangeOf(ev: { repo?: unknown; base?: unknown; commits?: unknown; files?: unknown; paths?: unknown }): RepoChanges {
  const paths = parseChangedPaths(ev.paths);
  return {
    repo: String(ev.repo ?? ''), base: String(ev.base ?? ''), commits: Number(ev.commits) || 0, files: Number(ev.files) || 0,
    ...(paths ? { paths } : {}),
  };
}

/** Lines in an untracked file: 0 for a binary one, a large number for one too big to read. */
async function untrackedLines(file: string): Promise<number> {
  const st = await fs.stat(file);
  if (!st.isFile()) return 0;
  if (st.size > UNTRACKED_READ_MAX) return UNTRACKED_TOO_LARGE_LINES;
  const buf = await fs.readFile(file);
  if (buf.includes(0)) return 0;
  let n = 0;
  for (const b of buf) if (b === 10) n++;
  return buf.length && buf[buf.length - 1] !== 10 ? n + 1 : n;
}

/**
 * Per-file line counts of everything the session changed: tracked files against the merge base with `origin/<base>` (or HEAD
 * when there is no such ref), from `git diff --numstat --no-renames` (so a rename shows as the old path removed and the new one
 * added), plus untracked files. Undefined when git cannot tell.
 */
async function changedPaths(
  repoDir: string, base: string, untracked: string[], env: Record<string, string>, remoteUrl?: string,
): Promise<ChangedPath[] | undefined> {
  // Never the session's own origin/<base> (the agent can move or delete it) and never a fallback to HEAD: the base is fetched
  // afresh into a private ref; when that or the merge base is unavailable, the list is unknown.
  const from = await trustedMergeBase(repoDir, base, env, remoteUrl);
  if (!from) return undefined;
  const diff = await runGit(repoDir, ['diff', '--numstat', '--no-renames', '--no-ext-diff', '--no-textconv', '-z', from], env, true);
  if (diff.code !== 0) return undefined;
  const out: ChangedPath[] = [];
  const seen = new Set<string>();
  for (const rec of diff.stdout.split('\0')) {
    if (!rec) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(rec);
    if (!m) continue;
    if (seen.has(m[3])) continue;
    seen.add(m[3]);
    out.push({ path: m[3], added: m[1] === '-' ? 0 : Number(m[1]), removed: m[2] === '-' ? 0 : Number(m[2]) });
    if (out.length >= MAX_REPORTED_PATHS) return out;
  }
  for (const p of untracked) {
    if (seen.has(p)) continue;
    seen.add(p);
    let added = 0;
    try { added = await untrackedLines(path.join(repoDir, p)); } catch { added = 0; }
    out.push({ path: p, added, removed: 0 });
    if (out.length >= MAX_REPORTED_PATHS) return out;
  }
  return out;
}

/**
 * Uncommitted paths plus paths in commits ahead of `origin/<base>`, the number of those commits, and (`paths`) the per-file line
 * counts. `paths` is left out when git cannot produce it.
 *
 * This is the change REPORT (it feeds the portal's gate, which only decides whether to ask a person); it reads the session's own
 * repository with the hardened settings above, but a clean or smudge filter the agent configured can still run here. The enforcement
 * is pushBranch, which does not read the session repository's configuration at all.
 * `opts.env` holds the request's git settings (credentials, safe.directory); `opts.remoteUrl`, when given, is where the base is
 * fetched from (else the session's configured push URL).
 */
export async function detectChanges(
  repoDir: string, base: string, opts: { env?: Record<string, string>; remoteUrl?: string } = {},
): Promise<{ commits: number; files: number; paths?: ChangedPath[] }> {
  const env = opts.env ?? {};
  const files = new Set<string>();
  const untracked: string[] = [];
  const status = await runGit(repoDir, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], env);
  const entries = status.stdout.split('\0').filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    files.add(e.slice(3));
    if (e.startsWith('??')) untracked.push(e.slice(3));
    if (e[0] === 'R' || e[0] === 'C') i++; // the next entry is the rename's source path
  }
  let commits = 0;
  const ref = `origin/${base}`;
  const count = await runGit(repoDir, ['rev-list', '--count', `${ref}..HEAD`], env, true);
  if (count.code === 0) {
    commits = parseInt(count.stdout.trim(), 10) || 0;
    if (commits > 0) {
      const diff = await runGit(repoDir, ['diff', '--name-only', '--no-ext-diff', '-z', `${ref}...HEAD`], env, true);
      if (diff.code === 0) for (const f of diff.stdout.split('\0')) if (f) files.add(f);
    }
  }
  let paths: ChangedPath[] | undefined;
  try { paths = await changedPaths(repoDir, base, untracked, env, opts.remoteUrl); } catch { paths = undefined; }
  return { commits, files: files.size, ...(paths ? { paths } : {}) };
}

/**
 * Create `branch`, commit what is left after the excluded paths, and push it with a plain push.
 * Refuses protected or malformed names before touching git. Errors never carry URL credentials.
 *
 * With `denyPaths` (an auto-fix push) the work happens in a runner-private repository instead, see pushCheckedBranch.
 */
export async function pushBranch(opts: {
  repoDir: string; base: string; branch: string; message: string; env: Record<string, string>;
  protectedPatterns: string[]; defaultBranch?: string | null; identity?: { name: string; email: string };
  excludePaths?: string[];
  /**
   * Globs (case-insensitive) no pushed file may match. When given, the change is committed, checked and pushed from a private
   * repository (pushCheckedBranch), and any match, or a check that cannot be done, refuses the push.
   */
  denyPaths?: string[];
  /** The repository's URL from the finalize request: the base is fetched from it and the branch pushed to it (required with denyPaths). */
  remoteUrl?: string;
}): Promise<{ sha: string }> {
  const { repoDir, branch, env } = opts;
  if (!BRANCH_RE.test(branch) || branch.includes('..') || branch.includes('//') || branch.endsWith('/') || branch.endsWith('.lock') || branch.includes('/.')) {
    throw new Error('Refusing to push: invalid branch name');
  }
  if (isProtectedBranch(branch, opts.protectedPatterns, opts.defaultBranch)) {
    throw new Error(`Refusing to push: ${branch} is a protected branch`);
  }
  const name = opts.identity?.name?.trim() || 'Agent Portal';
  const email = opts.identity?.email?.trim() || 'agent-portal@users.noreply.invalid';
  const ident = ['-c', `user.name=${name}`, '-c', `user.email=${email}`];

  if (opts.denyPaths) return pushCheckedBranch({ ...opts, denyPaths: opts.denyPaths, ident });

  const current = (await runGit(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD'], env)).stdout.trim();
  if (current !== branch) await runGit(repoDir, ['checkout', '-b', branch], env);

  const pathspec = ['.', ...(opts.excludePaths ?? []).filter(Boolean).map((p) => `:(exclude,literal)${p}`)];
  await runGit(repoDir, ['add', '-A', '--', ...pathspec], env);
  const staged = await runGit(repoDir, ['diff', '--cached', '--quiet', '--no-ext-diff'], env, true);
  if (staged.code === 1) {
    await runGit(repoDir, [...ident, 'commit', '--no-verify', '-m', opts.message], env);
  } else if (staged.code !== 0) {
    throw new Error(`git diff failed: ${redact(staged.stderr.trim(), env).slice(0, 500)}`);
  }

  // The commit to push, resolved once: whatever happens to the branch ref afterwards, this commit is what is pushed.
  const resolved = await runGit(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], env, true);
  const sha = resolved.stdout.trim();
  if (resolved.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) throw new Error('Refusing to push: the branch commit could not be resolved');

  await testBeforePush(repoDir, branch);
  // Exactly that commit, to this branch only: no tag or other ref of the same name, no configured push refspecs, no tags.
  await runGit(repoDir, ['-c', 'push.followTags=false', 'push', '--no-verify', '--no-follow-tags', 'origin', `${sha}:refs/heads/${branch}`], env);
  return { sha };
}

/** Lines of the session repository's `.git/info/exclude` (a regular file of at most 1 MB), so the private commit leaves out what it did. */
async function sessionExcludes(repoDir: string): Promise<string> {
  try {
    const file = path.join(repoDir, '.git', 'info', 'exclude');
    const st = await fs.lstat(file);
    if (!st.isFile() || st.size > 1024 * 1024) return '';
    return await fs.readFile(file, 'utf8');
  } catch { return ''; }
}

/**
 * The auto-fix push (pushBranch with denyPaths), done so that nothing the agent can write in its repository is ever read as
 * configuration or run as code by the check or the push:
 *  1. a new bare repository in a fresh temporary folder outside the workspace (no hooks, no config beyond `git init`'s own);
 *  2. the session's HEAD commit is fetched into it by local path (objects only, hash-checked by the fetch);
 *  3. the base branch is fetched from the request's `remoteUrl` (never `.git/config` or `remote get-url`);
 *  4. uncommitted work is committed there through a temporary index over the session's folder as work tree, so the session's
 *     `.git/config` (filters, fsmonitor, hooks) is not read; the session repository itself is left as it is;
 *  5. the checks: every path changed from the merge base to the commit, every path of every commit in merge-base..commit (merges
 *     against each parent), and every path that differs between the base TIP and the commit (two-dot, so a protected file deleted or
 *     changed on the base since the fork cannot ride along: such a branch must be rebased on the base);
 *  6. exactly that commit is pushed to `refs/heads/<branch>` of `remoteUrl`; the temporary folder is removed in all cases.
 *
 * RESIDUAL RISK, stated plainly: the agent shares the microVM with the runner. A process the agent left running could still race this
 * (for example write into the temporary repository, or replace the git binary or the runner's files). The portal's own check after
 * the push (server/autofix/delivery.ts verifyPushedBranch: GitHub compare and tree difference) is independent of this machine, but it
 * runs AFTER the push, so a push-triggered workflow on the fix branch may already have run with the repository's secrets before the
 * portal deletes the branch. The independent control is a repository ruleset restricting who may push changes to
 * `.github/workflows/**`; draft_pr mode also needs runners built from this file (older runners refuse the request and nothing is pushed).
 */
async function pushCheckedBranch(opts: {
  repoDir: string; base: string; branch: string; message: string; env: Record<string, string>;
  excludePaths?: string[]; denyPaths: string[]; remoteUrl?: string; ident: string[];
}): Promise<{ sha: string }> {
  const { repoDir, branch, env } = opts;
  const sources = opts.denyPaths.filter((p) => typeof p === 'string' && p.trim());
  for (const g of sources) {
    const problem = protectedPatternProblem(g);
    if (problem) throw new ProtectedPathError(`Refusing to push: unsupported protected pattern ${JSON.stringify(g)} (${problem})`);
  }
  const remoteUrl = String(opts.remoteUrl ?? '');
  if (!remoteUrl || remoteUrl.startsWith('-') || hasControlChar(remoteUrl)) {
    throw new ProtectedPathError('Refusing to push: the request carries no remote URL to check the base against');
  }
  if (!BRANCH_RE.test(opts.base) || opts.base.includes('..')) throw new ProtectedPathError('Refusing to push: invalid base branch name');
  const patterns = sources.map(compileGlob);
  const refuse = (f: string, where: string): void => {
    const shown = JSON.stringify(f);
    if (f.length > PATH_CHECK_MAX) throw new ProtectedPathError(`Refusing to push: a changed path${where} is too long to check`);
    if (hasControlChar(f)) throw new ProtectedPathError(`Refusing to push: ${shown}${where} contains a control character`);
    const hit = deniedBy(f, patterns, sources);
    if (hit) throw new ProtectedPathError(`Refusing to push: ${shown} is a protected path (${hit})${where}`);
  };

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-push-'));
  try {
    const repo = path.join(tmp, 'repo.git');
    await runGit(tmp, ['init', '--quiet', '--bare', '--template=', repo], env);
    const inRepo = (args: string[], allowFail = true, internal: Record<string, string> = {}) => runGit(repo, args, env, allowFail, internal);

    // 2. The session's commit, objects only (git upload-pack in the session folder sends them; nothing there is configured for us).
    const head = await inRepo(['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--', repoDir, '+HEAD:refs/portal/head']);
    if (head.code !== 0) throw new Error(`Refusing to push: the session's commit could not be read: ${redact(head.stderr.trim(), env).slice(0, 300)}`);
    // 3. The base, from the request's URL.
    const fetched = await inRepo(['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--', remoteUrl, `+refs/heads/${opts.base}:${PRIVATE_BASE_REF}`]);
    if (fetched.code !== 0) throw new ProtectedPathError('Refusing to push: the base branch could not be fetched to check the changed files');
    const shallow = await inRepo(['rev-parse', '--is-shallow-repository']);
    if (shallow.code !== 0 || shallow.stdout.trim() !== 'false') throw new ProtectedPathError("Refusing to push: the session's history is incomplete (shallow) and cannot be checked");
    const headSha = (await inRepo(['rev-parse', '--verify', '--quiet', 'refs/portal/head^{commit}'])).stdout.trim();
    const baseTip = (await inRepo(['rev-parse', '--verify', '--quiet', `${PRIVATE_BASE_REF}^{commit}`])).stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(headSha) || !/^[0-9a-f]{40,64}$/.test(baseTip)) throw new ProtectedPathError('Refusing to push: the commits could not be resolved');

    // 4. Uncommitted work, committed here: the session folder is only read as a work tree.
    await fs.mkdir(path.join(repo, 'info'), { recursive: true });
    await fs.writeFile(path.join(repo, 'info', 'exclude'), await sessionExcludes(repoDir));
    const index = { GIT_INDEX_FILE: path.join(tmp, 'index') };
    const wt = ['--git-dir', repo, '--work-tree', repoDir];
    const inTree = (args: string[]) => runGit(repoDir, [...wt, ...args], env, false, index);
    await inTree(['read-tree', headSha]);
    const pathspec = ['.', ...(opts.excludePaths ?? []).filter(Boolean).map((p) => `:(exclude,literal)${p}`)];
    await inTree(['add', '-A', '--', ...pathspec]);
    const tree = (await inTree(['write-tree'])).stdout.trim();
    const headTree = (await inRepo(['rev-parse', '--verify', '--quiet', `${headSha}^{tree}`])).stdout.trim();
    let sha = headSha;
    if (tree !== headTree) {
      sha = (await runGit(repo, [...opts.ident, 'commit-tree', tree, '-p', headSha, '-m', opts.message], env)).stdout.trim();
    }
    if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error('Refusing to push: the branch commit could not be created');

    // 5. The checks, all in the private repository.
    const mbRes = await inRepo(['merge-base', baseTip, sha]);
    const mb = mbRes.stdout.trim();
    if (mbRes.code !== 0 || !/^[0-9a-f]{40,64}$/.test(mb)) throw new ProtectedPathError('Refusing to push: the branch has no common history with the base branch');
    const diffArgs = ['diff', '--name-only', '--no-renames', '--no-ext-diff', '--no-textconv', '-z'];
    const diff = await inRepo([...diffArgs, mb, sha]);
    if (diff.code !== 0) throw new ProtectedPathError('Refusing to push: the changed files could not be listed');
    for (const f of diff.stdout.split('\0')) if (f) refuse(f, '');
    // Every commit that will be pushed, too: a protected file added and reverted on the way still sits in the pushed history. Merge
    // commits are listed against each parent (--diff-merges=separate), so a file a merge resolution adds is seen; a merge of the base
    // into the branch then lists the base's own changes as well, which can refuse a push that is in fact fine (fails closed).
    const count = await inRepo(['rev-list', '--count', `${mb}..${sha}`]);
    const n = parseInt(count.stdout.trim(), 10);
    if (count.code !== 0 || !Number.isFinite(n)) throw new ProtectedPathError('Refusing to push: the commits could not be counted');
    if (n > MAX_SCANNED_COMMITS) throw new ProtectedPathError(`Refusing to push: too many commits to check (${n}, at most ${MAX_SCANNED_COMMITS})`);
    const log = await inRepo(['log', '--name-only', '--no-renames', '--no-ext-diff', '--no-textconv', '--diff-merges=separate', '-z', '--format=', `${mb}..${sha}`]);
    if (log.code !== 0) throw new ProtectedPathError('Refusing to push: the commits could not be listed');
    const names = log.stdout.split('\0').filter(Boolean);
    if (names.length > MAX_SCANNED_PATHS) throw new ProtectedPathError(`Refusing to push: too many changed paths in the commits to check (at most ${MAX_SCANNED_PATHS})`);
    for (const f of names) refuse(f, ' in an intermediate commit');
    // Two-dot: what the branch's tree differs in from the base TIP. A protected file the base deleted or changed since the fork would
    // otherwise come back with the branch. This also refuses a fine fix whose base moved a protected file after the fork: it must be
    // rebased on the base branch first (fails closed).
    const tip = await inRepo([...diffArgs, baseTip, sha]);
    if (tip.code !== 0) throw new ProtectedPathError('Refusing to push: the difference from the base branch could not be listed');
    for (const f of tip.stdout.split('\0')) if (f) refuse(f, ` (it differs from the tip of ${opts.base}, which changed it since the fix branched off; rebase the fix on the base branch)`);

    // 6. Exactly the checked commit, to this branch only, at the request's URL.
    await testBeforePush(repoDir, branch);
    await runGit(repo, ['-c', 'push.followTags=false', 'push', '--quiet', '--no-verify', '--no-follow-tags', '--', remoteUrl, `${sha}:refs/heads/${branch}`], env);
    return { sha };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}
