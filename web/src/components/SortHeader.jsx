/**
 * SortHeader — a <th> that contains a <button> for keyboard-accessible sorting.
 *
 * Props:
 *   col       { key, label } — column definition.
 *   sortKey   Active column key (from useSortable).
 *   sortDir   'asc' | 'desc' | null (from useSortable).
 *   onSort    toggle function from useSortable.
 *   className Extra class on the <th>.
 *   children  Column label (overrides col.label).
 */
export function SortHeader({ col, sortKey, sortDir, onSort, className, children, style }) {
  const active = sortKey === col.key;
  const ariaSort = active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none';
  const label = children ?? col.label ?? col.key;

  return (
    <th
      aria-sort={ariaSort}
      className={className}
      style={style}
    >
      <button
        type="button"
        className="sort-btn"
        onClick={() => onSort(col.key)}
        title={active
          ? (sortDir === 'asc' ? `Sorted A→Z — click for Z→A` : `Sorted Z→A — click to clear`)
          : `Sort by ${label}`}
      >
        <span>{label}</span>
        <span className="sort-icon" aria-hidden="true">
          {active && sortDir === 'asc' ? '▲' : active && sortDir === 'desc' ? '▼' : <span className="sort-hint">⇅</span>}
        </span>
      </button>
    </th>
  );
}
