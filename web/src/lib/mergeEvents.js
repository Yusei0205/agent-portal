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
export function mergeConsecutiveAssistantText(events, engine = '') {
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
          // Streamed chunks (Kiro ACP, payload.stream) are partial text and join
          // as-is. Otherwise insert a newline when the running text doesn't
          // already end with one, so trimmed chunks don't run together.
          // Earlier Codex builds omitted stream:true on native deltas. Recover those saved responses too.
          const isStream = e => e.payload?.stream === true || (engine === 'codex' && e.payload?.stream === undefined);
          const streamed = isStream(events[j]) && isStream(events[j - 1]);
          if (!streamed && text && !text.endsWith('\n')) {
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

// ── mergeEventLists ────────────────────────────────────────────────────────────

/**
 * Compute a stable deduplication key for an event.
 *
 * Transcript events carry `src: 'r' | 'w'` (run event vs workflow event).
 * Stream events (from useRunStream, all from p6_events) have no `src` field;
 * they are treated as src='r'.
 *
 * Events without an `id` return null — they cannot be deduped.
 *
 * @param {{ src?: string, id?: number | string | null }} e
 * @returns {string | null}
 */
function eventKey(e) {
  if (e.id == null) return null;
  const src = e.src ?? 'r';
  return `${src}:${e.id}`;
}

/**
 * Compare two events for chronological sort.
 *
 * Sort order: created_at ASC → src ASC ('r' before 'w') → id ASC.
 * This mirrors the server's DESC ordering reversed to oldest-first.
 * Events without created_at sort last.
 *
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
function compareEvents(a, b) {
  const ta = a.created_at ?? '';
  const tb = b.created_at ?? '';
  if (ta < tb) return -1;
  if (ta > tb) return 1;
  const sa = a.src ?? 'r';
  const sb = b.src ?? 'r';
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return Number(a.id ?? 0) - Number(b.id ?? 0);
}

/**
 * Merge two event arrays into one chronologically-ordered, deduplicated list.
 *
 * Deduplication key: `${src}:${id}` — treats missing `src` as 'r' (stream events).
 * This correctly distinguishes `r:5` (p6_events row 5) from `w:5`
 * (p6_workflow_events row 5), preventing cross-table id collisions.
 *
 * When the same key appears in both lists, the version from `b` is kept
 * ("overlay wins"). Pass the full stream-event array as `b` so the complete
 * stream copy is preferred over a partial transcript snapshot.
 *
 * Events without an `id` are included from both lists without deduplication
 * (they are rare; typically synthetic or legacy events).
 *
 * @param {Array} a  Base list (e.g. existing transcript snapshot / earlierEvents)
 * @param {Array} b  Overlay list (e.g. full stream events for the completed run)
 * @returns {Array}  Merged, deduped, sorted oldest-first
 */
export function mergeEventLists(a, b) {
  /** @type {Map<string, number>} key → index in `out` */
  const seen = new Map();
  const out = [];

  // Process b first so its entries occupy the "seen" slot — if a contains the
  // same key it is silently dropped, making b (stream) win over a (snapshot).
  for (const e of b) {
    const k = eventKey(e);
    if (k == null) { out.push(e); continue; }
    if (!seen.has(k)) { seen.set(k, out.length); out.push(e); }
  }
  for (const e of a) {
    const k = eventKey(e);
    if (k == null) { out.push(e); continue; }
    if (!seen.has(k)) { seen.set(k, out.length); out.push(e); }
  }

  return out.sort(compareEvents);
}

// ── collectThoughtParagraphs ──────────────────────────────────────────────────

/**
 * Build the reasoning paragraphs shown under "Show reasoning".
 *
 * Kiro streams its reasoning as `agent-thought` events holding partial text,
 * often cut mid-word ("I need to figure out what ISD ref" + "ers to…"), so
 * consecutive thought events are joined exactly as sent. A new paragraph starts
 * only when another event (tool call, reply text, message) sits between two
 * thoughts, which is where the agent's reasoning actually paused.
 *
 * @param {Array<{type: string, payload?: Record<string, unknown>}>} events
 * @returns {string[]} non-empty paragraphs, trimmed
 */
export function collectThoughtParagraphs(events) {
  const paragraphs = [];
  let current = '';
  let inThought = false;
  for (const ev of events) {
    if (ev.type === 'agent-thought') {
      const chunk = String(ev.payload?.text ?? ev.payload?.content ?? '');
      if (!inThought && current) {
        paragraphs.push(current);
        current = '';
      }
      current += chunk;
      inThought = true;
    } else if (inThought) {
      inThought = false;
    }
  }
  if (current) paragraphs.push(current);
  return paragraphs.map((p) => p.trim()).filter(Boolean);
}
