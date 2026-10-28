/** Following symbolic links when checking where a path is. Kept apart from guardrails.ts, which touches no files. */
import fs from 'node:fs';
import path from 'node:path';
import { isInsideDir } from './guardrails.ts';

/**
 * Where a path really points once symbolic links (and Windows short names) are followed. A path that does not exist yet
 * resolves through its nearest existing folder, so a file about to be written inside a linked folder is placed where
 * the link leads.
 */
export function realPath(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** isInsideDir, with symbolic links followed on both sides: a link inside the project that points elsewhere is outside. */
export function isReallyInsideDir(base: string, target: string): boolean {
  return isInsideDir(base, target) && isInsideDir(realPath(base), realPath(target));
}
