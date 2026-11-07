/**
 * Finalize helpers for the runners (server/agent/runner-finalize.ts): find what a session changed in a repository,
 * pick a branch name, check protected branches, and push one new branch.
 *
 * Shared with the runner build (agent-runner/build.mjs copies it into shared/), so it imports only node: modules.
 * Every git call goes through execFile with an argument array (never a shell), and nothing here ever forces a push.
 */

import { execFile } from 'node:child_process';

export interface RepoChanges { repo: string; base: string; commits: number; files: number }

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const GIT_TIMEOUT_MS = 120_000;

/** Lowercase `[a-z0-9-]`, runs collapsed, no leading or trailing dash, at most `max` characters. */
export function slugify(text: string, max = 40): string {
  const s = String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '');
  return s.slice(0, Math.max(0, max)).replace(/-+$/, '');
}

/** `portal/<KEY>-<slug>` or `portal/<slug>`; on a clash with `taken` append -2, -3, ... */
export type PushErrorCode = 'no-permission' | 'no-workspace' | 'failed';

/** Sorts a push failure into what the person should be told. Shared by the runner (which sends the code) and the portal (fallback). */
export function classifyPushError(text: string): PushErrorCode {
  if (/restore|snapshot|workspace|repos\/ (is )?missing|no such (file|directory)/i.test(text) && !/permission/i.test(text)) return 'no-workspace';
  if (/permission|denied|forbidden|\b40[13]\b|not authori[sz]ed|authentication|could not read username|access/i.test(text)) return 'no-permission';
  return 'failed';
}

export function branchNameFor(opts: { ticketKey?: string | null; title: string; taken?: string[] }): string {
  const key = String(opts.ticketKey ?? '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const slug = slugify(opts.title) || 'changes';
  const stem = `portal/${key ? `${key}-` : ''}${slug}`;
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

function runGit(cwd: string, args: string[], env: Record<string, string> = {}, allowFail = false): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' },
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

/** Uncommitted paths plus paths in commits ahead of `origin/<base>`, and the number of those commits. */
export async function detectChanges(repoDir: string, base: string): Promise<{ commits: number; files: number }> {
  const files = new Set<string>();
  const status = await runGit(repoDir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const entries = status.stdout.split('\0').filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    files.add(e.slice(3));
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
  return { commits, files: files.size };
}

/**
 * Create `branch`, commit what is left after the excluded paths, and push it with a plain push.
 * Refuses protected or malformed names before touching git. Errors never carry URL credentials.
 */
export async function pushBranch(opts: {
  repoDir: string; base: string; branch: string; message: string; env: Record<string, string>;
  protectedPatterns: string[]; defaultBranch?: string | null; identity?: { name: string; email: string };
  excludePaths?: string[];
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

  await runGit(repoDir, ['push', '--no-verify', 'origin', branch], env);
  const sha = (await runGit(repoDir, ['rev-parse', 'HEAD'], env)).stdout.trim();
  return { sha };
}
