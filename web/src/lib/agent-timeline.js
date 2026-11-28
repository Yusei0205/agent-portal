/**
 * The Agents Timeline view's pure parts: how long something ran, and how agents are grouped into bursts of activity.
 *
 * A session can span days (a run today, another tomorrow). On one axis from the first start to the last finish, an agent that
 * ran for four minutes is a sliver, so the agents are grouped into bursts, each with its own scale from its first start to
 * its last finish. A pause longer than BURST_GAP_MS starts a new burst.
 */

export const BURST_GAP_MS = 10 * 60_000;

/** A length of time in the two most useful units: "45s", "4m 41s", "1h 12m", "2d 3h". */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 1) return ms > 0 ? '<1s' : '0s';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/**
 * Agents with a start and an end (milliseconds) as bursts, oldest first. Each burst has its own start and end and the agents
 * in it, ordered by when they started; `pauseBefore` is how long nothing ran between it and the burst before (0 for the first).
 * @template {{ start: number, end: number }} T
 * @param {T[]} spans
 * @returns {Array<{ start: number, end: number, total: number, pauseBefore: number, items: T[] }>}
 */
export function timelineBursts(spans, gapMs = BURST_GAP_MS) {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const bursts = [];
  for (const s of sorted) {
    const last = bursts[bursts.length - 1];
    if (last && s.start <= last.end + gapMs) {
      last.items.push(s);
      last.end = Math.max(last.end, s.end);
    } else {
      bursts.push({ start: s.start, end: s.end, total: 1, pauseBefore: last ? Math.max(0, s.start - last.end) : 0, items: [s] });
    }
  }
  // A burst shorter than a second still gets a scale to draw on.
  for (const b of bursts) b.total = Math.max(1000, b.end - b.start);
  return bursts;
}

/** Where an agent's bar sits on its burst's scale, as percentages: left edge and width (never thinner than `min`). */
export function barBox(span, burst, min = 1.5) {
  const left = Math.min(100 - min, Math.max(0, ((span.start - burst.start) / burst.total) * 100));
  const width = Math.min(100 - left, Math.max(min, ((span.end - span.start) / burst.total) * 100));
  return { left, width };
}

/** Labels for the scale of a burst: elapsed time at 0, 25, 50, 75 and 100%. */
export function scaleTicks(total, count = 5) {
  return Array.from({ length: count }, (_, i) => formatDuration((total * i) / (count - 1)));
}
