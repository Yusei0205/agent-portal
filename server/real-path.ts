/**
 * Symlink-safe path utilities for guardrails.
 *
 * Kept separate from server/agent/guard.ts so the guard module stays free of
 * filesystem side-effects (guard.ts contains only pure string operations).
 * This module is server-side only; it is not needed inside the AgentCore microVM
 * because the container's workDir is already the real path and no symlinks can
 * escape it.
 */

import fs from 'node:fs';
import path from 'node:path';

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * True when `target` is inside `base` (or equal to it).
 * Uses path normalisation only — does not resolve symlinks.
 */
export function isInsideDir(base: string, target: string): boolean {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The real path `p` resolves to once symbolic links (and Windows short names)
 * are followed. For a path whose leaf does not yet exist, resolves through the
 * nearest existing ancestor — so a file about to be written inside a linked
 * directory is correctly placed where the link leads.
 */
export function realPath(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p); // reached filesystem root
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * isInsideDir with symbolic links followed on both sides.
 *
 * A symlink inside the working copy that points elsewhere is treated as
 * outside, preventing path-traversal via junctions or symlinks.
 *
 * Example: workDir/docs/link → /tmp/secret — isReallyInsideDir(workDir, workDir/docs/link/x) is false.
 */
export function isReallyInsideDir(base: string, target: string): boolean {
  return isInsideDir(base, target) && isInsideDir(realPath(base), realPath(target));
}
