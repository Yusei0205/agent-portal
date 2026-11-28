/**
 * Click-to-sort for tables.
 *
 *   const { sorted, sortProps } = useSort(rows, {
 *     key:     (r) => r.key,
 *     updated: (r) => r.updated,      // date strings and numbers sort as such
 *   });
 *   ...
 *   <th {...sortProps('key')}>Key</th>
 *   {sorted.map(...)}
 *
 * Click a heading to sort ascending, click again for descending, a third time to go back to the original order.
 * Empty values always sort last. Text is compared naturally (RLP-9 before RLP-10, case-insensitive).
 */

import { useCallback, useMemo, useState } from 'react';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function normalise(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isNaN(v) ? null : v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.getTime();
  const s = String(v).trim();
  if (!s) return null;
  // ISO-style dates sort by time
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}.*)?$/.test(s)) {
    const t = Date.parse(s);
    if (!Number.isNaN(t)) return t;
  }
  return s;
}

function compare(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return collator.compare(String(a), String(b));
}

/**
 * @param {any[]} rows
 * @param {Record<string, (row: any) => any>} getters  how to read each sortable column
 * @param {{ key: string, dir: 'asc' | 'desc' } | null} [initial]
 */
export function useSort(rows, getters, initial = null) {
  const [sort, setSort] = useState(initial);

  const sorted = useMemo(() => {
    const list = Array.isArray(rows) ? rows : [];
    const get = sort && getters[sort.key];
    if (!get) return list;
    const dir = sort.dir === 'desc' ? -1 : 1;
    return list
      .map((row, i) => ({ row, i, v: normalise(get(row)) }))
      .sort((x, y) => {
        if (x.v === null && y.v === null) return x.i - y.i;
        if (x.v === null) return 1;   // empty last, in both directions
        if (y.v === null) return -1;
        const c = compare(x.v, y.v) * dir;
        return c !== 0 ? c : x.i - y.i;
      })
      .map((x) => x.row);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sort]);

  const toggle = useCallback((key) => {
    setSort((s) => {
      if (!s || s.key !== key) return { key, dir: 'asc' };
      if (s.dir === 'asc') return { key, dir: 'desc' };
      return null;
    });
  }, []);

  /** Props for a <th>: makes it clickable (mouse and keyboard) and reports the sort state to screen readers. */
  const sortProps = useCallback((key) => {
    const active = sort?.key === key;
    return {
      scope: 'col',
      tabIndex: 0,
      role: 'columnheader',
      'aria-sort': active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none',
      className: `th-sortable${active ? ' th-sorted' : ''}`,
      'data-dir': active ? sort.dir : undefined,
      onClick: () => toggle(key),
      onKeyDown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(key); }
      },
      title: 'Click to sort',
    };
  }, [sort, toggle]);

  return { sorted, sortProps, sort };
}

export default useSort;
