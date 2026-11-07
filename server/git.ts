/**
 * Thin git utility wrapper for portal-initiated git commands.
 *
 * All portal git calls use GIT_BASE, which:
 *   - Enables long-paths on Windows (core.longpaths=true)
 *   - Disables git hooks by pointing core.hooksPath at a folder that is never
 *     created: agents work in these repositories and could leave a hook behind
 *     for the portal to run during push/fetch (same CVE class as the Copilot and
 *     Cursor tool-settings vulnerabilities). Trade-off: Git LFS hooks do not run
 *     on portal pushes.
 *   - Disables fsmonitor so an agent-written fsmonitor program never runs on the
 *     portal server.
 */

import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export interface GitResult {
  stdout: string;
  stderr: string;
}

// Windows stops at 260 characters unless git is told otherwise; some repositories
// have deeper paths than that.
// The portal's own git commands also run no hooks and no fsmonitor program: agents
// work in these repositories and could leave a hook (or a core.fsmonitor setting)
// behind for the portal to run later, after the run and its approvals.
// The hooks folder named here is never created.
const NO_HOOKS = path.join(os.tmpdir(), 'agent-portal-no-git-hooks');
export const GIT_BASE = [
  '-c', 'core.longpaths=true',
  '-c', `core.hooksPath=${NO_HOOKS}`,
  '-c', 'core.fsmonitor=false',
];

export function git(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; maxBuffer?: number } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...GIT_BASE, ...args],
      {
        cwd: opts.cwd,
        env: opts.env ?? (process.env as Record<string, string>),
        timeout: opts.timeoutMs ?? 30_000,
        maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          const gitErr = new Error(
            `git ${args[0] ?? ''} failed (exit ${(err as NodeJS.ErrnoException & { code?: number }).code ?? '?'}): ${stderr.trim() || err.message}`,
          );
          (gitErr as Error & { stderr: string; stdout: string }).stderr = stderr;
          (gitErr as Error & { stderr: string; stdout: string }).stdout = stdout;
          reject(gitErr);
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });
}

/** Spawn git with streaming output. Returns the child process. */
export function gitSpawn(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): ReturnType<typeof spawn> {
  return spawn('git', [...GIT_BASE, ...args], {
    cwd: opts.cwd,
    env: opts.env ?? (process.env as Record<string, string>),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}
