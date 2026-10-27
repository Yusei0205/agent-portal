/** Child processes: stopping a whole process tree, and running a shell check with a time limit. */
import { spawn } from 'node:child_process';

/**
 * Kill a process and everything it started. On Windows, taskkill /T /F ends the whole tree. Elsewhere the process
 * must have been started with `detached: true` (its own process group): the group gets SIGTERM, then SIGKILL.
 */
export function killProcessTree(pid: number): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
      setTimeout(() => {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }, 2000).unref();
    }
  } catch { /* already gone */ }
}

/** The environment for checks: without the portal's own keys and tokens. */
function checkEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(AWS_|ANTHROPIC_|PORTAL_|GITHUB_|GH_)/i.test(k)) env[k] = v;
  return env;
}

/** How long to wait for the output to close after a timed-out check was killed before giving up on it. */
const AFTER_KILL_MS = 5000;

/**
 * Run a shell command as a check: exit code 0 passes. On timeout the whole process tree is killed (a shell's
 * children, such as npm's node or a test watcher, would otherwise keep running and keep the output open), and the
 * result comes back within a few seconds of the limit even if something still holds the output open.
 */
export function runShellCheck(command: string, cwd: string, timeoutMs: number, timeoutNote: string): Promise<{ ok: boolean; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, env: checkEnv(), shell: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    let out = '';
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let giveUp: NodeJS.Timeout | undefined;
    const add = (d: Buffer) => {
      out = (out + d.toString()).slice(-6000);
    };
    const finish = (r: { ok: boolean; output: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(giveUp);
      resolve({ ...r, timedOut });
    };
    child.stdout!.on('data', add);
    child.stderr!.on('data', add);
    timer = setTimeout(() => {
      timedOut = true;
      out += `\n${timeoutNote}`;
      killProcessTree(child.pid ?? 0);
      giveUp = setTimeout(() => {
        child.stdout!.destroy();
        child.stderr!.destroy();
        finish({ ok: false, output: out.trim().slice(-4000) });
      }, AFTER_KILL_MS);
      giveUp.unref();
    }, timeoutMs);
    child.on('error', (e) => finish({ ok: false, output: `Could not start the check: ${e.message}` }));
    child.on('close', (code) => finish({ ok: code === 0 && !timedOut, output: out.trim().slice(-4000) }));
  });
}
