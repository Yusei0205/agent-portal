import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './util.ts';

export class CodexRuntimeError extends HttpError {
  constructor(public code: string, message: string, status = 503) {
    super(status, message);
    this.name = 'CodexRuntimeError';
  }
}

function fileExists(file: string): boolean {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

/** Resolve a native executable or the official npm JS launcher without invoking a shell. */
export function resolveCodexCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  configured = process.env.PORTAL_CODEX_BIN,
): { command: string; args: string[] } {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const entries = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':')
    .map(p => p.trim().replace(/^"|"$/g, '')).filter(Boolean);
  const requested = configured?.trim();
  const candidates: string[] = [];
  if (requested) {
    if (paths.isAbsolute(requested) || /[\\/]/.test(requested)) candidates.push(requested);
    else for (const dir of entries) candidates.push(paths.join(dir, requested), ...(platform === 'win32' ? [paths.join(dir, requested + '.exe')] : []));
  } else {
    for (const dir of entries) candidates.push(paths.join(dir, platform === 'win32' ? 'codex.exe' : 'codex'));
    if (platform === 'win32') {
      const local = env.LOCALAPPDATA;
      if (local) candidates.push(paths.join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'), paths.join(local, 'OpenAI', 'Codex', 'bin', 'codex.exe'));
      for (const dir of entries) candidates.push(paths.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
      if (env.APPDATA) candidates.push(paths.join(env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
    }
  }
  for (let candidate of candidates) {
    // npm's Windows .cmd files cannot be passed to spawn(shell:false).
    if (/\.(cmd|bat)$/i.test(candidate)) candidate = paths.join(paths.dirname(candidate), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (!fileExists(candidate)) continue;
    if (/\.m?js$/i.test(candidate)) return { command: process.execPath, args: [candidate] };
    return { command: candidate, args: [] };
  }
  throw new CodexRuntimeError('codex_not_installed', requested
    ? 'The configured Codex executable was not found. Check PORTAL_CODEX_BIN on the portal host.'
    : 'Codex CLI was not found on the portal host. Install Codex CLI or set PORTAL_CODEX_BIN to its executable.');
}
