/**
 * Terminal-style editing rules for the chat box, as pure functions (tested without a page):
 *   - "@path" file mentions: which mention the caret is in, and what to list for it;
 *   - Ctrl+R reverse search through the messages sent before;
 *   - "\" + Enter for a new line, and Ctrl+U to clear back to the start of the line.
 */

/**
 * The "@mention" the caret is inside, or null. A mention starts at the beginning of the text or after whitespace
 * ("a@b.com" is not one) and runs up to the caret with no whitespace in it.
 * Returns { start, end, query } where `query` is what was typed after the "@".
 */
export function findMention(text, caret) {
  const before = text.slice(0, caret);
  const m = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (!m) return null;
  const query = m[1];
  return { start: caret - query.length - 1, end: caret, query };
}

/** "src/app/ma" -> { dir: "src/app", name: "ma" }: the folder to list and the filter for its entries. */
export function splitMentionPath(query) {
  const clean = query.replace(/^\.?\//, '');
  const i = clean.lastIndexOf('/');
  return i < 0 ? { dir: '', name: clean } : { dir: clean.slice(0, i), name: clean.slice(i + 1) };
}

/** Entries of a folder that match what was typed: names that start with it first, then names that contain it. */
export function filterEntries(entries, name, max = 40) {
  const n = name.toLowerCase();
  const visible = entries.filter((e) => !e.name.startsWith('.') || n.startsWith('.'));
  const starts = visible.filter((e) => e.name.toLowerCase().startsWith(n));
  const has = n ? visible.filter((e) => !e.name.toLowerCase().startsWith(n) && e.name.toLowerCase().includes(n)) : [];
  const byKind = (a, b) => (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1) || a.name.localeCompare(b.name);
  return [...starts.sort(byKind), ...has.sort(byKind)].slice(0, max);
}

/**
 * Text with the mention replaced by the picked path. A folder keeps the mention open (ends with "/") so the next level
 * lists; a file ends it with a space. Returns { value, caret }.
 */
export function applyMention(text, mention, entryPath, isDir) {
  const path = entryPath.replace(/^\/+/, '');
  const insert = `@${path}${isDir ? '/' : ' '}`;
  const value = text.slice(0, mention.start) + insert + text.slice(mention.end);
  return { value, caret: mention.start + insert.length };
}

/** Messages that contain the query, newest first (case-insensitive). An empty query matches nothing. */
export function searchHistory(list, query, max = 8) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (let i = list.length - 1; i >= 0 && out.length < max; i--) {
    if (list[i].toLowerCase().includes(q)) out.push(list[i]);
  }
  return out;
}

/**
 * Enter after a trailing backslash is a new line, as in Claude Code: the "\" is replaced by a line break.
 * Returns { value, caret } or null when the caret is not right after a backslash.
 */
export function backslashNewline(text, caret) {
  if (caret < 1 || text[caret - 1] !== '\\') return null;
  return { value: `${text.slice(0, caret - 1)}\n${text.slice(caret)}`, caret };
}

/** Ctrl+U: removes what is before the caret on the current line. Returns { value, caret }. */
export function clearToLineStart(text, caret) {
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
  return { value: text.slice(0, lineStart) + text.slice(caret), caret: lineStart };
}
