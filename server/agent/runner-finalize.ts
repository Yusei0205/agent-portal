/**
 * Finalize helpers for the runners (server/agent/runner-finalize.ts): find what a session changed in a repository,
 * pick a branch name, check protected branches, and push one new branch.
 *
 * Shared with the runner build (agent-runner/build.mjs copies it into shared/), so it imports only node: modules.
 * Every git call goes through execFile with an argument array (never a shell), and nothing here ever forces a push.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
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

/** Exact names and `*` patterns (`release/*`). The default branch is always protected. */
export function isProtectedBranch(name: string, patterns: string[], defaultBranch?: string | null): boolean {
  if (defaultBranch && name === defaultBranch) return true;
  for (const raw of patterns) {
    const p = String(raw ?? '').trim();
    if (!p) continue;
    if (!p.includes('*')) {
      if (name === p) return true;
      continue;
    }
    const re = new RegExp('^' + p.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    if (re.test(name)) return true;
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
 * off, and the system-wide config is not read. The global config is still read (nothing the runners set relies on it either, but
 * turning it off is left for a later change).
 */
export const TRUSTED_GIT_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_GRAFT_FILE: '/nonexistent/agent-portal-no-grafts',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
});

function runGit(cwd: string, args: string[], env: Record<string, string> = {}, allowFail = false): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      env: { ...process.env, ...env, ...TRUSTED_GIT_ENV },
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
      reject(new Error(`git ${args[0] === '-c' ? args.filter((a) => !a.startsWith('-') && !a.includes('=')).join(' ') : args[0]} failed: ${detail}`));
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
 * Fetch `base` from the URL pushes go to into PRIVATE_BASE_REF (forced, overwriting whatever is there) and return the merge base of
 * it and HEAD, or null when either step fails. The session's remote-tracking refs are not trusted.
 */
async function trustedMergeBase(repoDir: string, base: string, env: Record<string, string>, head = 'HEAD'): Promise<string | null> {
  if (!BRANCH_RE.test(base) || base.includes('..')) return null;
  const url = await runGit(repoDir, ['remote', 'get-url', '--push', 'origin'], env, true);
  const remote = url.code === 0 && url.stdout.trim() ? url.stdout.trim() : 'origin';
  const fetched = await runGit(repoDir, ['fetch', '--no-tags', '--quiet', remote, `+refs/heads/${base}:${PRIVATE_BASE_REF}`], env, true);
  if (fetched.code !== 0) return null;
  const mb = await runGit(repoDir, ['merge-base', PRIVATE_BASE_REF, head], env, true);
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
  if (/[{}[\]]/.test(g)) return 'uses { } [ or ] (only *, ** and ? are supported)';
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
  return {
    test(pathIn: string): boolean {
      const s = String(pathIn).toLowerCase();
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
    },
  };
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

/** Raised by pushBranch when the branch would carry a denied path. */
let beforePushHook: ((repoDir: string, branch: string) => Promise<void>) | null = null;
/** Tests only: runs after the checks and before the push (to move refs in between). Null restores nothing-in-between. */
export function _setBeforePushHookForTest(fn: ((repoDir: string, branch: string) => Promise<void>) | null): void { beforePushHook = fn; }

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
async function changedPaths(repoDir: string, base: string, untracked: string[]): Promise<ChangedPath[] | undefined> {
  // Never the session's own origin/<base> (the agent can move or delete it) and never a fallback to HEAD: the base is fetched
  // afresh into a private ref; when that or the merge base is unavailable, the list is unknown.
  const from = await trustedMergeBase(repoDir, base, {});
  if (!from) return undefined;
  const diff = await runGit(repoDir, ['diff', '--numstat', '--no-renames', '-z', from], {}, true);
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
 */
export async function detectChanges(repoDir: string, base: string): Promise<{ commits: number; files: number; paths?: ChangedPath[] }> {
  const files = new Set<string>();
  const untracked: string[] = [];
  const status = await runGit(repoDir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const entries = status.stdout.split('\0').filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    files.add(e.slice(3));
    if (e.startsWith('??')) untracked.push(e.slice(3));
    if (e[0] === 'R' || e[0] === 'C') i++; // the next entry is the rename's source path
  }
  let commits = 0;
  const ref = `origin/${base}`;
  const count = await runGit(repoDir, ['rev-list', '--count', `${ref}..HEAD`], {}, true);
  if (count.code === 0) {
    commits = parseInt(count.stdout.trim(), 10) || 0;
    if (commits > 0) {
      const diff = await runGit(repoDir, ['diff', '--name-only', '-z', `${ref}...HEAD`], {}, true);
      if (diff.code === 0) for (const f of diff.stdout.split('\0')) if (f) files.add(f);
    }
  }
  let paths: ChangedPath[] | undefined;
  try { paths = await changedPaths(repoDir, base, untracked); } catch { paths = undefined; }
  return { commits, files: files.size, ...(paths ? { paths } : {}) };
}

/**
 * Create `branch`, commit what is left after the excluded paths, and push it with a plain push.
 * Refuses protected or malformed names before touching git. Errors never carry URL credentials.
 */
export async function pushBranch(opts: {
  repoDir: string; base: string; branch: string; message: string; env: Record<string, string>;
  protectedPatterns: string[]; defaultBranch?: string | null; identity?: { name: string; email: string };
  excludePaths?: string[];
  /**
   * Globs (case-insensitive) no pushed file may match. When given, the base is fetched into a private ref right before the push and
   * every file changed from its merge base to HEAD is checked; any match, or a base that cannot be fetched, refuses the push.
   */
  denyPaths?: string[];
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
  const ident = ['-c', `user.name=${name}`, '-c', `user.email=${email}`, '-c', 'commit.gpgsign=false'];

  const current = (await runGit(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD'], env)).stdout.trim();
  if (current !== branch) await runGit(repoDir, ['checkout', '-b', branch], env);

  const pathspec = ['.', ...(opts.excludePaths ?? []).filter(Boolean).map((p) => `:(exclude,literal)${p}`)];
  await runGit(repoDir, ['add', '-A', '--', ...pathspec], env);
  const staged = await runGit(repoDir, ['diff', '--cached', '--quiet'], env, true);
  if (staged.code === 1) {
    await runGit(repoDir, [...ident, 'commit', '--no-verify', '-m', opts.message], env);
  } else if (staged.code !== 0) {
    throw new Error(`git diff failed: ${redact(staged.stderr.trim(), env).slice(0, 500)}`);
  }

  // The commit to check and to push, resolved once: whatever happens to the branch ref afterwards, this commit is what is pushed.
  const resolved = await runGit(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], env, true);
  const sha = resolved.stdout.trim();
  if (resolved.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) throw new Error('Refusing to push: the branch commit could not be resolved');

  if (opts.denyPaths) {
    const sources = opts.denyPaths.filter((p) => typeof p === 'string' && p.trim());
    for (const g of sources) {
      const problem = protectedPatternProblem(g);
      if (problem) throw new ProtectedPathError(`Refusing to push: unsupported protected pattern ${JSON.stringify(g)} (${problem})`);
    }
    const patterns = sources.map(compileGlob);
    const refuse = (f: string, where: string): void => {
      const shown = JSON.stringify(f);
      if (f.length > PATH_CHECK_MAX) throw new ProtectedPathError(`Refusing to push: a changed path${where} is too long to check`);
      if (hasControlChar(f)) throw new ProtectedPathError(`Refusing to push: ${shown}${where} contains a control character`);
      const hit = deniedBy(f, patterns, sources);
      if (hit) throw new ProtectedPathError(`Refusing to push: ${shown} is a protected path (${hit})${where}`);
    };
    const mb = await trustedMergeBase(repoDir, opts.base, env, sha);
    if (!mb) throw new ProtectedPathError('Refusing to push: the base branch could not be fetched to check the changed files');
    const diff = await runGit(repoDir, ['diff', '--name-only', '--no-renames', '-z', mb, sha], env, true);
    if (diff.code !== 0) throw new ProtectedPathError('Refusing to push: the changed files could not be listed');
    for (const f of diff.stdout.split('\0')) if (f) refuse(f, '');
    // Every commit that will be pushed, too: a protected file added and reverted on the way still sits in the pushed history. Merge
    // commits are listed against each parent (--diff-merges=separate), so a file a merge resolution adds is seen; a merge of the base
    // into the branch then lists the base's own changes as well, which can refuse a push that is in fact fine (fails closed).
    const count = await runGit(repoDir, ['rev-list', '--count', `${mb}..${sha}`], env, true);
    const n = parseInt(count.stdout.trim(), 10);
    if (count.code !== 0 || !Number.isFinite(n)) throw new ProtectedPathError('Refusing to push: the commits could not be counted');
    if (n > MAX_SCANNED_COMMITS) throw new ProtectedPathError(`Refusing to push: too many commits to check (${n}, at most ${MAX_SCANNED_COMMITS})`);
    const log = await runGit(repoDir, ['log', '--name-only', '--no-renames', '--diff-merges=separate', '-z', '--format=', `${mb}..${sha}`], env, true);
    if (log.code !== 0) throw new ProtectedPathError('Refusing to push: the commits could not be listed');
    const names = log.stdout.split('\0').filter(Boolean);
    if (names.length > MAX_SCANNED_PATHS) throw new ProtectedPathError(`Refusing to push: too many changed paths in the commits to check (at most ${MAX_SCANNED_PATHS})`);
    for (const f of names) refuse(f, ' in an intermediate commit');
  }

  if (beforePushHook) await beforePushHook(repoDir, branch);
  // Exactly the checked commit, to this branch only: no tag or other ref of the same name, no configured push refspecs, no tags.
  await runGit(repoDir, ['-c', 'push.followTags=false', 'push', '--no-verify', '--no-follow-tags', 'origin', `${sha}:refs/heads/${branch}`], env);
  return { sha };
}
