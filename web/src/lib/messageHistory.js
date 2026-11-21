/**
 * The chat box's Up and Down arrows, as in a terminal: Up brings back the message you sent before, again and again further
 * back; Down comes forward again and ends on what you had typed. Pure functions, so the rules are tested without a page.
 */

/** The history with `text` added at the end (not twice in a row, at most `max` kept). */
export function addToHistory(list, text, max = 100) {
  const t = String(text ?? '').trim();
  if (!t || list[list.length - 1] === t) return list;
  return [...list, t].slice(-max);
}

/** State when nothing is being browsed: the position is past the end of the list. */
export function idleHistory(list) {
  return { index: list.length, draft: '' };
}

/**
 * What an arrow key does in the box. Returns null when the key is the box's own (moving the caret inside a message of
 * several lines, or nothing to recall), else { value, state } to put in the box.
 * Up only counts on the first line and Down on the last, so a long message can still be moved through with the arrows.
 */
export function stepHistory(list, state, key, { value, selStart, selEnd }) {
  if (selStart !== selEnd) return null;
  const browsing = state.index < list.length;
  if (key === 'ArrowUp') {
    if (!list.length || value.slice(0, selStart).includes('\n')) return null;
    const index = browsing ? Math.max(0, state.index - 1) : list.length - 1;
    return { value: list[index], state: { index, draft: browsing ? state.draft : value } };
  }
  if (key === 'ArrowDown') {
    if (!browsing || value.slice(selEnd).includes('\n')) return null;
    const index = state.index + 1;
    if (index >= list.length) return { value: state.draft, state: { index: list.length, draft: '' } };
    return { value: list[index], state: { index, draft: state.draft } };
  }
  return null;
}
