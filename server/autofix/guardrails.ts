/** Diff guardrails for auto-fix: pure checks of a proposed change against the policy. No I/O. */

import type { AutofixPolicy } from './policy.ts';
import { hasControlChar, normaliseRepoPath, protectedDirectoryOf, protectedGlobMatches, protectedPatternProblem } from '../agent/runner-finalize.ts';

/** A rename's old path is not carried here; the runner reports renames as removal + addition (--no-renames), so both paths are checked. */
export interface DiffFile { path: string; added: number; removed: number }

/** The only protected globs a `deps` change may touch. */
export const DEPS_LOCKFILE_GLOBS: ReadonlySet<string> = new Set(['package-lock.json', '**/package-lock.json']);

/**
 * `protected_paths` are matched by the runner's own matcher (protectedGlobMatches in agent/runner-finalize.ts), the same function the
 * runner applies before an auto-fix push: case-insensitive, dot files and dot-directories included, newlines matched like any other
 * character. A path holding a control character is a violation by itself.
 */
export function checkDiff(files: DiffFile[], p: AutofixPolicy, kind: string): { ok: boolean; large: boolean; violations: string[] } {
  const violations: string[] = [];
  // A stored pattern the matcher does not support (braces, brackets) or that is over the caps would protect nothing: fail closed, so
  // nothing goes ahead until an admin fixes the policy (the policy refuses such patterns when saved).
  const usable: string[] = [];
  for (const g of p.protected_paths) {
    if (protectedPatternProblem(g)) violations.push(`unsupported protected pattern: ${g}`);
    else usable.push(g);
  }
  let lines = 0;
  for (const f of files) {
    lines += f.added + f.removed;
    const norm = normaliseRepoPath(f.path);
    const control = hasControlChar(norm);
    const shown = control ? JSON.stringify(norm) : norm;
    if (control) violations.push(`${shown} contains a control character`);
    // A single entry standing where a protected folder is (a symlink or submodule at `infra`) counts as that folder.
    let hit = usable.filter(g => protectedGlobMatches(norm, g) || protectedDirectoryOf(norm, g));
    // For deps, the lockfile globs are exempt, but only when they are the sole globs the path matches.
    if (kind === 'deps' && hit.every(g => DEPS_LOCKFILE_GLOBS.has(g))) hit = [];
    if (hit.length) violations.push(`${shown} is a protected path (${hit[0]})`);
  }
  return {
    ok: violations.length === 0,
    large: files.length > p.limits.max_files || lines > p.limits.max_lines,
    violations,
  };
}
