/**
 * The change an edit tool call made, as diff lines, for showing it inline under the call.
 * Handles the Edit / str_replace shape ({ old_string, new_string }) and MultiEdit ({ edits: [...] }).
 * Returns null when the call is not that kind of edit.
 */

const MAX_LINES = 400;

function pairsOf(input) {
  let obj = input;
  if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { return null; } }
  if (!obj || typeof obj !== 'object') return null;
  const list = Array.isArray(obj.edits) ? obj.edits : [obj];
  const pairs = list
    .map((e) => ({ oldText: e?.old_string ?? e?.oldString ?? e?.old_str, newText: e?.new_string ?? e?.newString ?? e?.new_str }))
    .filter((p) => typeof p.oldText === 'string' && typeof p.newText === 'string');
  return pairs.length ? pairs : null;
}

/** @returns {Array<{ kind: 'del' | 'add' | 'gap', text: string }> | null} */
export function editDiffLines(input) {
  const pairs = pairsOf(input);
  if (!pairs) return null;
  const lines = [];
  pairs.forEach((p, i) => {
    if (i > 0) lines.push({ kind: 'gap', text: '⋯' });
    // Lines both sides share at the start and end are context, not change: trim them so only what changed shows.
    const a = p.oldText.split('\n');
    const b = p.newText.split('\n');
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    for (const t of a.slice(head, a.length - tail)) lines.push({ kind: 'del', text: t });
    for (const t of b.slice(head, b.length - tail)) lines.push({ kind: 'add', text: t });
  });
  return lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), { kind: 'gap', text: `⋯ ${lines.length - MAX_LINES} more lines` }] : lines;
}
