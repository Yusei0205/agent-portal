/**
 * Event-stream merge utilities for the live session view.
 *
 * Exported as a standalone module so the pure logic can be unit-tested in
 * Node.js without a DOM or React dependency.
 */

/**
 * Merge consecutive `assistant-text` events into a single event so they
 * render as one message bubble instead of many fragmented bordered blocks.
 *
 * Separator behaviour
 * -------------------
 * Engines emit `assistant-text` in different ways:
 *   - Kiro plain-text mode emits one event per line and always ends the text
 *     with `\n`, so consecutive chunks join cleanly.
 *   - Kiro JSON mode and other engines emit trimmed text with no trailing
 *     newline, which would cause adjacent chunks to run together (e.g.
 *     "infrastructure.I haven't…").
 *
 * When the running accumulated text does NOT already end with a newline, a
 * `\n` is inserted before the next non-empty chunk.  This keeps Kiro
 * per-line output unchanged while fixing the run-together case.
 *
 * Cross-turn safety
 * -----------------
 * The inner loop stops as soon as it encounters any event that is not
 * `assistant-text` (human messages, tool-start/end, run-complete, etc.), so
 * two assistant messages separated by a human turn are never joined.
 *
 * @param {Array<{type: string, id?: string, payload?: Record<string,unknown>}>} events
 * @returns {Array}
 */
export function mergeConsecutiveAssistantText(events) {
  if (!events.length) return events;
  const result = [];
  let i = 0;
  while (i < events.length) {
    const ev = events[i];
    if (ev.type === 'assistant-text') {
      let text = ev.payload?.text ?? ev.payload?.content ?? '';
      const baseId = ev.id ?? `at-${i}`;
      let j = i + 1;
      while (j < events.length && events[j].type === 'assistant-text') {
        const chunk = events[j].payload?.text ?? events[j].payload?.content ?? '';
        if (chunk) {
          // Insert a newline separator when the running text doesn't already
          // end with one.  This prevents trimmed chunks from running together.
          if (text && !text.endsWith('\n')) {
            text += '\n';
          }
          text += chunk;
        }
        j++;
      }
      result.push({ ...ev, id: baseId, payload: { ...(ev.payload ?? {}), text } });
      i = j;
    } else {
      result.push(ev);
      i++;
    }
  }
  return result;
}
