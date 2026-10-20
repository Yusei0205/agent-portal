import { useMemo, useState } from 'react';

/**
 * Comparison types used by per-column accessors.
 *
 * - 'text'   → localeCompare, numeric:true, sensitivity:'base'
 * - 'number' → plain numeric
 * - 'date'   → Date.parse → numeric
 * - 'size'   → numeric (bytes)
 * - 'status' → custom order array, falls back to text
 *
 * null/undefined/'' always sort to the bottom regardless of direction.
 */

// Sensible status order (lower index = "more active/positive")
const STATUS_ORDER = [
  'running', 'queued', 'waiting', 'active',
  'ready', 'published', 'pass',
  'completed', 'done', 'read',
  'draft', 'generating', 'pending', 'processing',
  'stale', 'out_of_date',
  'failed', 'error', 'disabled', 'archived',
];

function statusRank(v) {
  if (v === null || v === undefined) return Infinity;
  const idx = STATUS_ORDER.indexOf(String(v).toLowerCase());
  return idx === -1 ? STATUS_ORDER.length : idx;
}

function compare(a, b, type) {
  // nulls / empty always last
  const aEmpty = a === null || a === undefined || a === '';
  const bEmpty = b === null || b === undefined || b === '';
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;

  switch (type) {
    case 'number':
    case 'size':
      return Number(a) - Number(b);
    case 'date':
      return Date.parse(a) - Date.parse(b);
    case 'status': {
      const ra = statusRank(a);
      const rb = statusRank(b);
      if (ra !== rb) return ra - rb;
      // fall through to text for tie-breaking
      return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
    }
    default: // 'text'
      return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  }
}

/**
 * useSortable — client-side sort for a flat array of rows.
 *
 * @param {Array}  rows        The full (possibly filtered) row array.
 * @param {Object} opts
 *   columns    Array of { key, accessor, type, label } objects.
 *              accessor may be a string key or a function (row) => value.
 *   initial    { key, dir } – default sort state (optional).
 *   storageKey localStorage key to persist the choice (optional).
 *   pinned     Predicate (row) => boolean – rows that always float to the top (optional).
 *
 * @returns { sorted, sortKey, sortDir, toggle, SortState }
 *   sorted    — the sorted rows (pin rows always come first).
 *   sortKey   — active column key, or null.
 *   sortDir   — 'asc' | 'desc' | null.
 *   toggle    — toggle(columnKey) — cycles asc → desc → null (default order).
 */
export function useSortable(rows, { columns = [], initial = null, storageKey = null, pinned = null } = {}) {
  const [sort, setSort] = useState(() => {
    if (storageKey) {
      try {
        const raw = localStorage.getItem(storageKey);
        if (raw) {
          const parsed = JSON.parse(raw);
          // Validate that the stored key is still a valid column
          if (columns.some((c) => c.key === parsed.key) && ['asc', 'desc'].includes(parsed.dir)) {
            return parsed;
          }
        }
      } catch {
        /* ignore */
      }
    }
    return initial || null; // null = default order
  });

  const toggle = (key) => {
    setSort((prev) => {
      let next;
      if (!prev || prev.key !== key) {
        next = { key, dir: 'asc' };
      } else if (prev.dir === 'asc') {
        next = { key, dir: 'desc' };
      } else {
        next = null; // back to default
      }
      if (storageKey) {
        try {
          if (next) localStorage.setItem(storageKey, JSON.stringify(next));
          else localStorage.removeItem(storageKey);
        } catch { /* ignore */ }
      }
      return next;
    });
  };

  const sorted = useMemo(() => {
    if (!sort || !rows) return rows || [];

    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;

    const accessor = typeof col.accessor === 'function'
      ? col.accessor
      : (row) => row[col.accessor];
    const type = col.type || 'text';

    const pinFn = typeof pinned === 'function' ? pinned : null;

    const pinnedRows = pinFn ? rows.filter(pinFn) : [];
    const normalRows = pinFn ? rows.filter((r) => !pinFn(r)) : [...rows];

    normalRows.sort((a, b) => {
      const av = accessor(a);
      const bv = accessor(b);
      const c = compare(av, bv, type);
      return sort.dir === 'asc' ? c : -c;
    });

    return [...pinnedRows, ...normalRows];
  }, [rows, sort, columns, pinned]);

  return {
    sorted,
    sortKey: sort?.key ?? null,
    sortDir: sort?.dir ?? null,
    toggle,
  };
}
