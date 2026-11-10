/**
 * Putting a session's repositories into an AgentCore runner's work folder.
 *
 * Pure Node code (no portal imports): the agent-runner and kiro-runner images COPY this file into their build
 * (as shared/runner-repos.ts), and the portal imports the types and the validator directly.
 *
 * The portal sends each repository as { name, url, branch?, env? }. `env` carries git's own settings for
 * authentication (GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n holding an http.extraHeader), so the
 * credential never appears in a command line, a URL or the repository's .git/config. The runner re-checks every
 * rule here: it never trusts the payload.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface RunnerRepo {
  /** Folder name under repos/. */
  name: string;
  /** HTTPS clone URL (no credentials inside it). */
  url: string;
  branch?: string;
  /** Git authentication settings, GIT_* variables only. */
  env?: Record<string, string>;
}

export const RUNNER_REPO_LIMITS = {
  repos: 10,
  nameChars: 100,
  urlChars: 2000,
  envEntries: 24,
  envValueChars: 8000,
  cloneMs: 600_000,
};

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENV_KEY_RE = /^(GIT_TERMINAL_PROMPT|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d{1,2}|GIT_CONFIG_VALUE_\d{1,2})$/;

export function parseRunnerRepos(
  value: unknown,
): { ok: true; repos: RunnerRepo[] } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, repos: [] };
  if (!Array.isArray(value)) return { ok: false, error: '"repos" must be an array' };
  if (value.length > RUNNER_REPO_LIMITS.repos) return { ok: false, error: `"repos" has more than ${RUNNER_REPO_LIMITS.repos} entries` };

  const repos: RunnerRepo[] = [];
  const names = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return { ok: false, error: 'each repo must be an object' };
    const r = item as Record<string, unknown>;
    for (const key of Object.keys(r)) {
      if (!['name', 'url', 'branch', 'env'].includes(key)) return { ok: false, error: `unknown field in repo: "${key}"` };
    }
    const name = r.name;
    if (typeof name !== 'string' || !NAME_RE.test(name) || name.length > RUNNER_REPO_LIMITS.nameChars || name.includes('..')) {
      return { ok: false, error: 'repo.name must be letters, digits, dot, dash or underscore' };
    }
    if (names.has(name)) return { ok: false, error: `duplicate repo name "${name}"` };
    names.add(name);

    const url = r.url;
    if (typeof url !== 'string' || !url.startsWith('https://') || url.length > RUNNER_REPO_LIMITS.urlChars || /\s/.test(url)) {
      return { ok: false, error: 'repo.url must be an https URL' };
    }
    let branch: string | undefined;
    if (r.branch !== undefined && r.branch !== null && r.branch !== '') {
      if (typeof r.branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(r.branch) || r.branch.includes('..')) {
        return { ok: false, error: 'repo.branch is not a valid branch name' };
      }
      branch = r.branch;
    }
    let env: Record<string, string> | undefined;
    if (r.env !== undefined) {
      if (typeof r.env !== 'object' || r.env === null || Array.isArray(r.env)) return { ok: false, error: 'repo.env must be an object' };
      const entries = Object.entries(r.env as Record<string, unknown>);
      if (entries.length > RUNNER_REPO_LIMITS.envEntries) return { ok: false, error: 'repo.env has too many entries' };
      env = {};
      for (const [k, v] of entries) {
        if (!ENV_KEY_RE.test(k)) return { ok: false, error: `repo.env may only hold git settings (got "${k}")` };
        if (typeof v !== 'string' || v.length > RUNNER_REPO_LIMITS.envValueChars) return { ok: false, error: `repo.env "${k}" must be a string` };
        env[k] = v;
      }
      // The only git options allowed are the http.* ones (the auth header) and an empty credential.helper (it
      // switches off any saved helper). Nothing that could run a command gets through.
      for (const [k, v] of Object.entries(env)) {
        const m = /^GIT_CONFIG_KEY_(\d{1,2})$/.exec(k);
        if (!m) continue;
        const isHttp = /^http\./i.test(v);
        const isEmptyHelper = v === 'credential.helper' && env[`GIT_CONFIG_VALUE_${m[1]}`] === '';
        if (!isHttp && !isEmptyHelper) return { ok: false, error: 'repo.env may only set http.* git options' };
      }
    }
    repos.push({ name, url, ...(branch ? { branch } : {}), ...(env ? { env } : {}) });
  }
  return { ok: true, repos };
}

function runGit(args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, onStderr?: (chunk: string) => void): Promise<{ code: number; err: string; signal?: string }> {
  return new Promise((resolve) => {
    const proc = spawn('git', args, { cwd, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d: Buffer) => {
      const t = d.toString('utf8');
      onStderr?.(t);
      // Progress lines are overwritten in place by git (carriage returns); keep only the tail so a long clone cannot fill the buffer.
      err = (err + t).slice(-4000);
    });
    const timer = setTimeout(() => { proc.kill('SIGKILL'); err += '\ntimed out'; }, timeoutMs);
    proc.on('error', (e) => { clearTimeout(timer); resolve({ code: 1, err: String(e.message) }); });
    proc.on('close', (code, signal) => { clearTimeout(timer); resolve({ code: code ?? 1, err, ...(signal ? { signal } : {}) }); });
  });
}

/**
 * The runner's workspace folder: on the machine's own disk, so it is fast and behaves like any normal folder (no
 * mount quirks). It lasts as long as the machine does; runner-snapshot.ts saves it to S3 and restores it on the
 * next machine of the same session.
 */
export const PERSIST_ROOT = process.env.RUNNER_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');
const MIN_FREE_BYTES = 150 * 1024 * 1024;

/** The workspace folder, when it is writable and has room; otherwise null (repositories stay in the temporary work folder). */
export function usablePersistRoot(root = PERSIST_ROOT): string | null {
  try {
    fs.mkdirSync(root, { recursive: true });
    if (!fs.statSync(root).isDirectory()) return null;
    fs.accessSync(root, fs.constants.W_OK);
    const st = fs.statfsSync(root);
    if (Number(st.bavail) * Number(st.bsize) < MIN_FREE_BYTES) return null;
    return root;
  } catch {
    return null;
  }
}

function gitEnv(repo: RunnerRepo): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(repo.env ?? {}) };
}

/**
 * The persistent folder is a mounted file system whose files report a different owner than the runner's user, and
 * git then refuses to work in a repository there ("dubious ownership"). Two narrow fixes, both naming only the exact
 * repository folders the runner created (never a wildcard):
 *  - the runner's own git calls pass `-c safe.directory=<folder>`;
 *  - the agent runs git with its own HOME, so a `.gitconfig` in that HOME lists the same folders.
 * Repository names are validated, so the paths cannot point anywhere else.
 */
function trustArgs(abs: string): string[] {
  return ['-c', `safe.directory=${abs}`];
}

export function trustFoldersForAgent(homeDir: string, folders: string[]): void {
  if (folders.length === 0) return;
  const file = path.join(homeDir, '.gitconfig');
  let current = '';
  try { current = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  const missing = folders.filter((f) => !current.includes(`directory = ${f}\n`));
  if (missing.length === 0) return;
  const block = `${current && !current.endsWith('\n') ? '\n' : ''}[safe]\n${missing.map((f) => `\tdirectory = ${f}\n`).join('')}`;
  fs.writeFileSync(file, current + block, 'utf8');
}

/**
 * A repository that is already on disk (kept from an earlier message of the same session) is brought up to date,
 * unless the agent changed it: edits and commits made in the session are never thrown away.
 */
async function refreshExisting(
  repo: RunnerRepo,
  dest: string,
  trust: string[],
  emit: (e: { type: 'status'; text: string }) => void,
): Promise<void> {
  const env = gitEnv(repo);
  const branch = repo.branch ?? '';
  const out = await gitOut([...trust, 'status', '--porcelain'], dest, env);
  const ahead = branch ? await gitOut([...trust, 'rev-list', '--count', `origin/${branch}..HEAD`], dest, env) : '0';
  if (out.trim() !== '' || (ahead.trim() !== '' && ahead.trim() !== '0')) {
    emit({ type: 'status', text: `${repo.name} already has your session's changes; left as it is.` });
    return;
  }
  const fetchArgs = [...trust, 'fetch', '--tags', 'origin', ...(branch ? [branch] : [])];
  const f = await runGit(fetchArgs, dest, env, 120_000);
  if (f.code !== 0) { emit({ type: 'status', text: `${repo.name}: kept the earlier copy (could not fetch updates).` }); return; }
  await runGit([...trust, 'reset', '--hard', 'FETCH_HEAD'], dest, env, 60_000);
  emit({ type: 'status', text: `${repo.name} is up to date.` });
}

function gitOut(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout.on('data', (d: Buffer) => { if (out.length < 4000) out += d.toString('utf8'); });
    const timer = setTimeout(() => proc.kill('SIGKILL'), 30_000);
    proc.on('error', () => { clearTimeout(timer); resolve(''); });
    proc.on('close', () => { clearTimeout(timer); resolve(out); });
  });
}

const PROGRESS_RE = /^(?:remote:\s+)?(Counting objects|Enumerating objects|Compressing objects|Receiving objects|Resolving deltas|Updating files):\s+(\d+)%\s*(?:\(([\d,]+)\/([\d,]+)\))?(.*)$/;
const PHASE: Record<string, [string, number, number, string]> = {
  'Enumerating objects': ['Counting objects', 0, 3, 'objects'],
  'Counting objects': ['Counting objects', 0, 3, 'objects'],
  'Compressing objects': ['Compressing objects', 3, 5, 'objects'],
  'Receiving objects': ['Receiving objects', 5, 75, 'objects'],
  'Resolving deltas': ['Resolving deltas', 75, 95, 'deltas'],
  'Updating files': ['Checking out files', 95, 100, 'files'],
};

/** Turns git's stderr progress (written with 
) into { phase, percent (overall, never going back), detail } updates, at most one a second. */
export function makeGitProgressReader(onUpdate: (u: { phase: string; percent: number; detail: string }) => void): (chunk: string) => void {
  let partial = '';
  let last = 0;
  let overall = 0;
  return (chunk: string) => {
    const parts = (partial + chunk).split(/[\r\n]/);
    partial = parts.pop() ?? '';
    for (const line of parts) {
      const m = PROGRESS_RE.exec(line.trim());
      if (!m) continue;
      const ph = PHASE[m[1]];
      if (!ph) continue;
      const pct = Number(m[2]);
      overall = Math.max(overall, Math.round(ph[1] + (pct / 100) * (ph[2] - ph[1])));
      const now = Date.now();
      if (now - last < 1000 && pct < 100) continue;
      last = now;
      let detail = '';
      if (m[3] && m[4]) detail = `${Number(m[3].replace(/,/g, '')).toLocaleString('en-US')} / ${Number(m[4].replace(/,/g, '')).toLocaleString('en-US')} ${ph[3]}`;
      const size = /[\d.]+\s*[KMGT]?iB(?!\/s)/.exec(m[5] ?? '')?.[0];
      const speed = /[\d.]+\s*[KMGT]?iB\/s/.exec(m[5] ?? '')?.[0];
      if (size) detail += ` · ${size}`;
      if (speed) detail += ` · ${speed}`;
      onUpdate({ phase: ph[0], percent: overall, detail });
    }
  };
}

/** How many files the repository's current checkout holds (tracked files), for the "N files" shown when it is ready. */
function countTrackedFiles(cwd: string, trust: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn('git', [...trust, 'ls-files', '-z'], { cwd, env, stdio: ['ignore', 'pipe', 'ignore'] });
    let n = 0;
    proc.stdout.on('data', (d: Buffer) => { for (const b of d) if (b === 0) n++; });
    const timer = setTimeout(() => proc.kill('SIGKILL'), 30_000);
    proc.on('error', () => { clearTimeout(timer); resolve(0); });
    proc.on('close', () => { clearTimeout(timer); resolve(n); });
  });
}

/**
 * Puts each repository under `<workDir>/repos/<name>` (full clone: all branches and tags, the full history). With `persistRoot`, the real folder is
 * `<persistRoot>/repos` and `<workDir>/repos` is a link to it, so the copy survives until the session is released.
 * `homeDir` is the agent's HOME: it gets a `.gitconfig` that trusts those repository folders.
 * A repository that cannot be cloned is reported and skipped (the run continues). Returns the names available.
 */
export async function cloneRunnerRepos(
  repos: RunnerRepo[],
  workDir: string,
  emit: (event: { type: 'status'; text: string }) => void,
  opts: { persistRoot?: string | null; homeDir?: string | null; onProgress?: (u: { name: string; phase: string; percent: number; detail: string; done?: boolean }) => void } = {},
): Promise<string[]> {
  const done: string[] = [];
  const reposDir = path.join(workDir, 'repos');
  const persist = opts.persistRoot ? usablePersistRoot(opts.persistRoot) : null;
  let realReposDir = reposDir;
  if (persist) {
    realReposDir = path.join(persist, 'repos');
    fs.mkdirSync(realReposDir, { recursive: true });
    if (!fs.existsSync(reposDir)) {
      try { fs.symlinkSync(realReposDir, reposDir, 'dir'); } catch { /* fall back to a plain folder below */ }
    }
    // If the link could not be made, the repositories stay in the temporary work folder instead.
    try { if (fs.realpathSync(reposDir) !== fs.realpathSync(realReposDir)) realReposDir = reposDir; } catch { realReposDir = reposDir; }
  }
  const trusted: string[] = [];
  const ready = new Set<string>();
  const processRepo = async (repo: RunnerRepo): Promise<void> => {
    const dest = path.join(reposDir, repo.name);
    const realDest = path.join(realReposDir, repo.name);
    const trust = persist ? trustArgs(realDest) : [];
    try {
      if (fs.lstatSync(dest).isSymbolicLink() && !fs.existsSync(dest)) fs.rmSync(dest, { force: true });
    } catch { /* nothing there */ }
    if (fs.existsSync(path.join(dest, '.git'))) {
      await refreshExisting(repo, dest, trust, emit);
      ready.add(repo.name);
      if (opts.onProgress) opts.onProgress({ name: repo.name, phase: 'Ready', percent: 100, detail: `${(await countTrackedFiles(dest, trust, gitEnv(repo))).toLocaleString('en-US')} files`, done: true });
      if (persist) trusted.push(realDest);
      return;
    }
    fs.mkdirSync(reposDir, { recursive: true });
    emit({ type: 'status', text: `Cloning ${repo.name}${repo.branch ? ` @ ${repo.branch}` : ''}…` });
    const args = ['clone', opts.onProgress ? '--progress' : '--quiet',
      ...(repo.branch ? ['--branch', repo.branch] : []), repo.url, dest];
    const onProgress = opts.onProgress;
    const reader = onProgress ? makeGitProgressReader((u) => onProgress({ name: repo.name, ...u })) : undefined;
    let res = await runGit(args, reposDir, gitEnv(repo), RUNNER_REPO_LIMITS.cloneMs, reader);
    if (res.code !== 0 && persist) {
      // The session's persistent folder is small (1 GB) and a mounted file system; if the clone did not fit or did
      // not work there, clone onto the machine's own disk instead and link it in. It then lasts as long as the
      // machine does, and the next message clones again.
      try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* ok */ }
      const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-repo-'));
      const localDest = path.join(localRoot, repo.name);
      emit({ type: 'status', text: `${repo.name} did not fit in the session's storage; cloning to temporary disk instead…` });
      const retry = await runGit(
        ['clone', '--quiet', ...(repo.branch ? ['--branch', repo.branch] : []), repo.url, localDest],
        localRoot, gitEnv(repo), RUNNER_REPO_LIMITS.cloneMs,
      );
      if (retry.code === 0) {
        try { fs.symlinkSync(localDest, dest, 'dir'); res = retry; } catch { /* keep the original failure */ }
      } else {
        try { fs.rmSync(localRoot, { recursive: true, force: true }); } catch { /* ok */ }
        res = { ...retry, err: `${res.err}\n${retry.err}` };
      }
    }
    if (res.code === 0) {
      ready.add(repo.name);
      if (opts.onProgress) opts.onProgress({ name: repo.name, phase: 'Ready', percent: 100, detail: `${(await countTrackedFiles(dest, trust, gitEnv(repo))).toLocaleString('en-US')} files`, done: true });
      // Only a clone that really is on the persistent folder needs trusting (a temporary one is owned by the runner).
      if (persist && fs.existsSync(dest) && fs.lstatSync(dest).isDirectory()) trusted.push(realDest);
    } else {
      // git writes progress with carriage returns; keep real error lines (fatal / error / warning) if there are any.
      const lines = res.err.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
      const errors = lines.filter((l) => /^(fatal|error|warning):/i.test(l)).slice(-3);
      const tail = errors.length ? errors.join(' | ') : (lines[lines.length - 1] ?? '');
      let free = '';
      try {
        const st = fs.statfsSync(persist ?? reposDir);
        free = `, free disk ${Math.round(Number(st.bavail) * Number(st.bsize) / 1048576)} MB`;
      } catch { /* ok */ }
      const why = `git exited ${res.signal ? `on signal ${res.signal}` : `with code ${res.code}`}${free}, free memory ${Math.round(os.freemem() / 1048576)} MB`;
      // Never echo anything that could hold a credential.
      emit({ type: 'status', text: `Could not clone ${repo.name} (${why}): ${tail.replace(/https?:\/\/[^@\s]*@/g, 'https://').slice(0, 260)}` });
      try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* ok */ }
    }
  };
  // Repositories are cloned side by side (a few at a time): the wait is the network, not the machine.
  const PARALLEL = 3;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(PARALLEL, repos.length) }, async () => {
    while (next < repos.length) await processRepo(repos[next++]);
  }));
  for (const r of repos) if (ready.has(r.name)) done.push(r.name);
  if (opts.homeDir && trusted.length > 0) {
    try { trustFoldersForAgent(opts.homeDir, trusted); } catch { /* the agent can still read the files */ }
  }
  if (done.length > 0) emit({ type: 'status', text: `Repositories available at: ${done.map((n) => `repos/${n}/`).join(', ')}` });
  return done;
}
