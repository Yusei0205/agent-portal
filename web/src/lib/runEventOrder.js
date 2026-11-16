/**
 * Keep a run's events sorted by id.
 *
 * On the cloud portal events arrive from two places: the live channel and a re-read of the stored history every few seconds.
 * They do not arrive in order, and the page used to append each one as it came, which scrambled streamed text. Events carry
 * an increasing numeric id, so each one is placed by id; an event without an id goes last. Returns a new array.
 *
 * @param {Array<{id?: number | string | null}>} events
 * @param {{id?: number | string | null}} ev
 */
export function insertRunEvent(events, ev) {
  const id = Number(ev?.id);
  if (ev?.id == null || Number.isNaN(id)) return [...events, ev];
  // Events mostly arrive in order, so look from the end.
  let i = events.length;
  while (i > 0) {
    const prev = Number(events[i - 1]?.id);
    if (events[i - 1]?.id == null || Number.isNaN(prev) || prev <= id) break;
    i -= 1;
  }
  return [...events.slice(0, i), ev, ...events.slice(i)];
}

/**
 * Adds a batch of events (a page of the stored history) to a run's events, kept sorted by id: one new array however many
 * events come, where insertRunEvent copies the array for each. A run can have tens of thousands of events.
 *
 * @param {Array<{id?: number | string | null}>} events
 * @param {Array<{id?: number | string | null}>} batch
 */
export function mergeRunEvents(events, batch) {
  if (!batch.length) return events;
  const out = events.concat(batch);
  const key = (e) => { const n = Number(e?.id); return e?.id == null || Number.isNaN(n) ? Infinity : n; };
  let sorted = true;
  for (let i = 1; i < out.length; i += 1) if (key(out[i - 1]) > key(out[i])) { sorted = false; break; }
  return sorted ? out : out.sort((a, b) => key(a) - key(b)); // Array.prototype.sort is stable
}
