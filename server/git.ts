import { execFile } from 'node:child_process';
import { HttpError } from './util.ts';

export interface GitResult {
  stdout: string;
  stderr: string;
}

export function git(args: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; maxBuffer?: number } = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: opts.cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', ...opts.env },
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || err.message).toString().trim().split('\n').slice(-6).join('\n');
          reject(new HttpError(400, `git ${args[0]} failed: ${redact(msg)}`));
          return;
        }
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      },
    );
  });
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
