/**
 * Cursor CLI command resolution (the `agent` binary, also installed as `cursor-agent`).
 *
 * PORTAL_CURSOR_BIN names the binary (a full path on Windows, where the installer puts agent.cmd
 * in %LOCALAPPDATA%\cursor-agent and does not add it to PATH). PORTAL_CURSOR_FAKE (tests) runs a
 * fixture script through node instead, with the fake path prepended to the arguments.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export function resolveCursorCmd(args: string[]): { cmd: string; fullArgs: string[]; shell: boolean } {
  const fake = process.env.PORTAL_CURSOR_FAKE;
  if (fake) return { cmd: process.execPath, fullArgs: [fake, ...args], shell: false };
  const cmd = process.env.PORTAL_CURSOR_BIN || 'agent';
  // A Windows .cmd shim cannot be started without a shell (EINVAL). Every argument is passed through
  // quoteWindowsArg then, so a prompt cannot break out of its quotes.
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
  return { cmd, fullArgs: shell ? args.map(quoteWindowsArg) : args, shell };
}

/** Quote one argument for cmd.exe: wrap in double quotes, double any inner quote, neutralise %, ^ and newlines. */
export function quoteWindowsArg(arg: string): string {
  const safe = arg.replace(/\r?\n/g, ' ').replace(/"/g, '""').replace(/%/g, '%%').replace(/\^/g, '^^');
  return `"${safe}"`;
}

export function spawnCursor(args: string[], options: SpawnOptions): ChildProcess {
  const { cmd, fullArgs, shell } = resolveCursorCmd(args);
  return spawn(cmd, fullArgs, { ...options, shell, windowsHide: true });
}

/** True when the binary can be started and answers --version (skipped for the fake). */
export async function cursorAvailable(): Promise<boolean> {
  if (process.env.PORTAL_CURSOR_FAKE) return true;
  return await new Promise<boolean>((resolve) => {
    try {
      const child = spawnCursor(['--version'], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    } catch { resolve(false); }
  });
}
