/**
 * How the sessions list is grouped: starred sessions first, then by day (default), by status or by engine.
 * Pure, so the list component only renders what this returns.
 */

export const GROUP_MODES = ['date', 'status', 'engine'];

const isActive = (w) => w.status === 'running' || w.status === 'pending';

/** Status bucket of a session: Running, Failed, Completed or Stopped (paused counts as stopped). */
export function statusBucket(w) {
  if (isActive(w)) return { key: 'running', label: 'Running' };
  if (w.status === 'failed') return { key: 'failed', label: 'Failed' };
  if (w.status === 'done') return { key: 'done', label: 'Completed' };
  return { key: 'stopped', label: 'Stopped' };
}

const STATUS_ORDER = ['running', 'failed', 'done', 'stopped'];

/** The ids a person starred for a project, from the stored JSON text (anything unusable gives an empty list). */
export function parseStarred(text) {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}

/** The starred ids with `id` added, or removed when it is already there. */
export function toggleStarred(ids, id) {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

/**
 * @param {Array<{ id: string, status: string, engine?: string, updated_at?: string }>} workflows
 * @param {{ mode?: 'date'|'status'|'engine', starred?: string[], dayLabel: (iso: string) => string, engineLabel?: (engine: string) => string }} opts
 * @returns {Array<{ key: string, label: string, items: any[], starred?: boolean }>}
 */
export function groupSessions(workflows, { mode = 'date', starred = [], dayLabel, engineLabel = (e) => String(e || 'Other') }) {
  const star = new Set(starred);
  const groups = [];
  const starredItems = workflows.filter((w) => star.has(w.id));
  if (starredItems.length) groups.push({ key: '__starred', label: 'Starred', items: starredItems, starred: true });
  const rest = workflows.filter((w) => !star.has(w.id));

  if (mode === 'status') {
    const map = new Map();
    for (const w of rest) {
      const b = statusBucket(w);
      if (!map.has(b.key)) map.set(b.key, { key: b.key, label: b.label, items: [] });
      map.get(b.key).items.push(w);
    }
    for (const k of STATUS_ORDER) if (map.has(k)) groups.push(map.get(k));
    return groups;
  }

  if (mode === 'engine') {
    const map = new Map();
    for (const w of rest) {
      const k = w.engine || 'other';
      if (!map.has(k)) map.set(k, { key: `engine:${k}`, label: engineLabel(w.engine), items: [] });
      map.get(k).items.push(w);
    }
    groups.push(...[...map.values()].sort((a, b) => a.label.localeCompare(b.label)));
    return groups;
  }

  const active = rest.filter(isActive);
  if (active.length) groups.push({ key: '__active', label: 'Active', items: active });
  const days = new Map();
  for (const w of rest.filter((x) => !isActive(x))) {
    const label = dayLabel(w.updated_at);
    if (!days.has(label)) days.set(label, []);
    days.get(label).push(w);
  }
  for (const [label, items] of days) groups.push({ key: label, label, items });
  return groups;
}
