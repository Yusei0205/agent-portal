/**
 * Output file path-matching utilities.
 *
 * Pure logic — no DOM, no React. Exported as a standalone module so the
 * logic can be unit-tested in Node.js (see test/output-files-match.test.ts).
 */

/**
 * Match a single mentioned path against a list of output files.
 *
 * Matching rules (per API contract):
 *   - Exact match:  outputFile.path === mentionedPath
 *   - Suffix match: outputFile.path ends with '/' + mentionedPath
 *
 * @param {string} mentionedPath
 * @param {Array<{id: string, path: string, name: string}>} outputFiles
 * @returns {typeof outputFiles[0] | null}
 */
export function matchOutputFile(mentionedPath, outputFiles) {
  if (!mentionedPath || !outputFiles?.length) return null;
  // Strip a leading slash if present (normalise)
  const normalized = mentionedPath.replace(/^\//, '');
  if (!normalized) return null;
  return outputFiles.find(
    (f) => f.path === normalized || f.path.endsWith('/' + normalized),
  ) ?? null;
}

/**
 * Generate every suffix of a forward-slash-separated path.
 * E.g. "a/b/c.png" → ["a/b/c.png", "b/c.png", "c.png"]
 *
 * @param {string} path
 * @returns {string[]}
 */
export function getAllSubpaths(path) {
  if (!path) return [];
  const parts = path.split('/');
  const result = [];
  for (let i = 0; i < parts.length; i++) {
    const sub = parts.slice(i).join('/');
    if (sub) result.push(sub);
  }
  return result;
}

/**
 * Find every position in `text` where an output file path (or a valid
 * suffix of one) is mentioned.
 *
 * Returns an array of non-overlapping matches sorted by start position.
 * When two candidates start at the same position, the longer one wins.
 *
 * @param {string} text
 * @param {Array<{id: string, path: string, name: string}>} outputFiles
 * @returns {Array<{start: number, end: number, file: typeof outputFiles[0]}>}
 */
export function findOutputFileMentions(text, outputFiles) {
  if (!text || !outputFiles?.length) return [];

  /** @type {Array<{start: number, end: number, pathLen: number, file: typeof outputFiles[0]}>} */
  const candidates = [];

  for (const file of outputFiles) {
    const subpaths = getAllSubpaths(file.path);
    for (const subpath of subpaths) {
      if (!subpath) continue;
      let idx = 0;
      while (idx < text.length) {
        const found = text.indexOf(subpath, idx);
        if (found === -1) break;
        candidates.push({ start: found, end: found + subpath.length, pathLen: subpath.length, file });
        idx = found + 1;
      }
    }
  }

  if (!candidates.length) return [];

  // Sort: by start asc, then by path length desc (prefer longer match at same position)
  candidates.sort((a, b) => a.start - b.start || b.pathLen - a.pathLen);

  // Remove overlapping candidates (keep the first / longest at each position)
  const result = [];
  let lastEnd = -1;
  for (const c of candidates) {
    if (c.start >= lastEnd) {
      result.push({ start: c.start, end: c.end, file: c.file });
      lastEnd = c.end;
    }
  }

  return result;
}
