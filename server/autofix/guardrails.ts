/** Diff guardrails for auto-fix: pure checks of a proposed change against the policy. No I/O. */

import path from 'node:path';
import type { AutofixPolicy } from './policy.ts';

export interface DiffFile { path: string; added: number; removed: number }

const LOCKFILE_NAMES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']);

/** Forward slashes, no leading ./ (path.matchesGlob treats backslash as an escape, so normalise first). */
function normalisePath(p: string): string {
  let n = p.replace(/\\/g, '/');
  while (n.startsWith('./')) n = n.slice(2);
  return n;
}

const isLockfile = (p: string) => LOCKFILE_NAMES.has(p.slice(p.lastIndexOf('/') + 1));

/** `protected_paths` patterns use path.matchesGlob, which matches dotfiles (e.g. `**\/.env*` matches `.env`). */
export function checkDiff(files: DiffFile[], p: AutofixPolicy, kind: string): { ok: boolean; large: boolean; violations: string[] } {
  const violations: string[] = [];
  let lines = 0;
  for (const f of files) {
    lines += f.added + f.removed;
    const norm = normalisePath(f.path);
    if (kind === 'deps' && isLockfile(norm)) continue;
    const hit = p.protected_paths.find(g => path.posix.matchesGlob(norm, g));
    if (hit) violations.push(`${norm} is a protected path (${hit})`);
  }
  return {
    ok: violations.length === 0,
    large: files.length > p.limits.max_files || lines > p.limits.max_lines,
    violations,
  };
}
