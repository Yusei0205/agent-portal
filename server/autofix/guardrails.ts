/** Diff guardrails for auto-fix: pure checks of a proposed change against the policy. No I/O. */

import path from 'node:path';
import type { AutofixPolicy } from './policy.ts';

/** A rename's old path is not carried, so a rename-away of a protected file is not detected (known limit). */
export interface DiffFile { path: string; added: number; removed: number }

/** The only protected globs a `deps` change may touch. */
const DEPS_LOCKFILE_GLOBS = new Set(['package-lock.json', '**/package-lock.json']);

/** Forward slashes, no leading ./ (path.matchesGlob treats backslash as an escape, so normalise first). */
function normalisePath(p: string): string {
  let n = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  while (n.startsWith('./') || n.startsWith('/')) n = n.startsWith('./') ? n.slice(2) : n.slice(1);
  return n;
}

/** `protected_paths` patterns use path.matchesGlob, which matches dotfiles (e.g. `**\/.env*` matches `.env`). */
export function checkDiff(files: DiffFile[], p: AutofixPolicy, kind: string): { ok: boolean; large: boolean; violations: string[] } {
  const violations: string[] = [];
  let lines = 0;
  for (const f of files) {
    lines += f.added + f.removed;
    const norm = normalisePath(f.path);
    // Case-insensitive: on macOS/Windows filesystems `.GitHub/Workflows` is the same directory.
    const lower = norm.toLowerCase();
    let hit = p.protected_paths.filter(g => path.posix.matchesGlob(lower, g.toLowerCase()));
    // For deps, the lockfile globs are exempt, but only when they are the sole globs the path matches.
    if (kind === 'deps' && hit.every(g => DEPS_LOCKFILE_GLOBS.has(g))) hit = [];
    if (hit.length) violations.push(`${norm} is a protected path (${hit[0]})`);
  }
  return {
    ok: violations.length === 0,
    large: files.length > p.limits.max_files || lines > p.limits.max_lines,
    violations,
  };
}
