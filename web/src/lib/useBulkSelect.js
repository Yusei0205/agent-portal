import { useState, useCallback, useMemo } from 'react';

/**
 * Bulk-selection hook for lists.
 *
 * @param {Array<{ id: string }>} items — items must each have an `id` property
 * @returns {{
 *   selected: Set<string>,
 *   toggle: (id: string) => void,
 *   toggleAll: () => void,
 *   clearAll: () => void,
 *   allSelected: boolean,
 *   someSelected: boolean,
 * }}
 */
export function useBulkSelect(items) {
  const [selected, setSelected] = useState(/** @type {Set<string>} */ (new Set()));

  const toggle = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const allIds = useMemo(() => items.map((item) => item.id), [items]);

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      if (prev.size === allIds.length && allIds.every((id) => prev.has(id))) {
        return new Set();
      }
      return new Set(allIds);
    });
  }, [allIds]);

  const clearAll = useCallback(() => setSelected(new Set()), []);

  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const someSelected = selected.size > 0 && !allSelected;

  return { selected, toggle, toggleAll, clearAll, allSelected, someSelected };
}

export default useBulkSelect;
