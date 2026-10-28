import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { HttpError } from './util.ts';

export interface GitResult {
  stdout: string;
  stderr: string;
}

// Windows stops at 260 characters unless git is told otherwise; some repositories have deeper paths than that.
// The portal's own git commands also run no hooks and no fsmonitor program: agents work in these repositories and
// could leave a hook (or a core.fsmonitor setting) behind for the portal to run later, after the run and its approvals.
// The hooks folder named here is never created.
const NO_HOOKS = path.join(os.tmpdir(), 'agent-portal-no-git-hooks');
export const GIT_BASE = ['-c', 'core.longpaths=true', '-c', `core.hooksPath=${NO_HOOKS}`, '-c', 'core.fsmonitor=false'];

export function git(args: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; maxBuffer?: number } = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      GIT_BASE.concat(args),
      {
        cwd: opts.cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', ...opts.env },
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          const msg = gitErrorSummary(stderr.toString(), err.message);
          reject(new HttpError(400, `git ${args[0]} failed: ${redact(msg)}`));
          return;
        }
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      },
    );
  });
}

export interface GitProgress {
  phase: string;
  /** Overall 0-100 across the whole command, never decreasing. */
  percent: number;
}

// Git reports each phase from 0 to 100 on its own; give every phase a slice of one overall bar.
const PHASES: [RegExp, string, number, number][] = [
  [/(?:Enumerating|Counting|Compressing) objects/i, 'Preparing', 0, 10],
  [/Receiving objects/i, 'Downloading', 10, 75],
  [/Resolving deltas/i, 'Resolving', 75, 90],
  [/(?:Updating|Checking out) files/i, 'Checking out files', 90, 100],
];

/** Like git(), but reports progress while it runs. Pass `--progress` in args so git writes progress when not on a terminal. */
export function gitProgress(args: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}, onProgress: (p: GitProgress) => void): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', GIT_BASE.concat(args), {
      cwd: opts.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let tail = '';
    let best = 0;
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 120_000);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => {
      const text = d.toString();
      stderr = (stderr + text).slice(-8000);
      // Progress lines end in \r, so split on both.
      const parts = (tail + text).split(/[\r\n]/);
      tail = parts.pop() ?? '';
      for (const line of parts) {
        const m = line.match(/:\s+(\d{1,3})%/);
        if (!m) continue;
        const phase = PHASES.find(([re]) => re.test(line));
        if (!phase) continue;
        const percent = Math.round(phase[2] + ((phase[3] - phase[2]) * Math.min(100, Number(m[1]))) / 100);
        if (percent > best) {
          best = percent;
          onProgress({ phase: phase[1], percent });
        }
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new HttpError(400, `git ${args[0]} failed: ${redact(e.message)}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      reject(new HttpError(400, `git ${args[0]} failed: ${redact(gitErrorSummary(stderr, `exit code ${code}`))}`));
    });
  });
}

/**
 * Pick the lines of git's stderr that explain a failure. Git mixes errors with progress and
 * per-ref summary lines (fetch --prune can print hundreds of "[deleted]" lines after the real
 * error), so prefer fatal:/error: lines and rejected refs, and fall back to the last few lines.
 */
export function gitErrorSummary(stderr: string, fallback: string): string {
  const lines = stderr
    .split(/[\r\n]+/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && !/^Cloning into/i.test(l) && !/:\s+\d{1,3}%/.test(l));
  const important = lines.filter((l) => /^(?:remote:\s*)?(?:fatal|error):/i.test(l.trim()) || /^\s*!\s/.test(l));
  const picked = important.length ? important.slice(0, 6) : lines.slice(-6);
  return picked.join('\n').trim() || fallback;
}

/** Never echo credentials back to the browser. */
export function redact(s: string): string {
  return s
    .replace(/(https?:\/\/)[^\s/@]+@/g, '$1***@')
    .replace(/(Authorization:\s*)(Basic|Bearer)\s+\S+/gi, '$1$2 ***')
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '***')
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, '***');
}

/** Git config passed through environment variables, so tokens never appear in argv or on disk. */
export function gitConfigEnv(pairs: [string, string][]): Record<string, string> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return env;
}

export const PORTAL_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Agent Portal',
  GIT_AUTHOR_EMAIL: 'agent-portal@localhost',
  GIT_COMMITTER_NAME: 'Agent Portal',
  GIT_COMMITTER_EMAIL: 'agent-portal@localhost',
};

/** Commit everything under `paths` in a local repository; no-op when nothing changed. */
export async function commitAll(cwd: string, message: string, paths: string[] = ['.']): Promise<boolean> {
  await git(['add', '-A', '--', ...paths], { cwd });
  const staged = await git(['diff', '--cached', '--name-only'], { cwd });
  if (!staged.stdout.trim()) return false;
  await git(['commit', '-q', '-m', message], { cwd, env: PORTAL_GIT_IDENTITY });
  return true;
}
