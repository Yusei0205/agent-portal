import { createHash } from 'node:crypto';

/** First path segment of a branch: `feature/login` -> `feature`. */
export function branchFamily(branch: string): string {
  return branch.split('/')[0] || branch;
}

/** Strip the parts of an error that vary between runs so the same failure normalizes to the same text. */
export function normalizeError(text: string): string {
  return text
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '')
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '')
    .replace(/\b0x[0-9a-fA-F]+\b/g, '')
    .replace(/\b[0-9a-fA-F]{8,}\b/g, '')
    .replace(/(?:[A-Za-z]:)?(?:[\\/][^\s\\/:()'"]+){2,}/g, (m) => '/' + (m.split(/[\\/]/).pop() ?? ''))
    .replace(/:\d+(?::\d+)?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function computeFingerprint(i: { repo: string; branch: string; kind: string; error: string }): string {
  return createHash('sha256')
    .update(`${i.repo}|${branchFamily(i.branch)}|${i.kind}|${normalizeError(i.error)}`)
    .digest('hex')
    .slice(0, 16);
}
