import { Icon } from './Icon.jsx';

/**
 * Floating bulk-action bar.
 * Appears at the bottom of its positioned container when selected.size > 0.
 *
 * @param {{
 *   selected: Set<string>,
 *   onDelete: () => void,
 *   onClear: () => void,
 *   busy?: boolean,
 * }} props
 */
export function BulkActionBar({ selected, onDelete, onClear, busy = false }) {
  if (selected.size === 0) return null;

  return (
    <div className="bulk-action-bar" role="toolbar" aria-label="Bulk actions">
      <span className="bulk-action-count">
        <Icon name="check" size={14} />
        {selected.size} session{selected.size === 1 ? '' : 's'} selected
      </span>
      <span className="bulk-action-sep" aria-hidden="true">·</span>
      <button
        type="button"
        className="btn btn-sm btn-danger"
        onClick={onDelete}
        disabled={busy}
        aria-label={`Delete ${selected.size} selected session${selected.size === 1 ? '' : 's'}`}
      >
        <Icon name="trash" size={13} />
        Delete selected
      </button>
      <button
        type="button"
        className="btn-icon"
        onClick={onClear}
        disabled={busy}
        aria-label="Clear selection"
        title="Clear selection"
      >
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

/**
 * Small hint shown above the list to tell users they can tick rows.
 */
export function BulkSelectHint() {
  return (
    <div className="bulk-select-hint" aria-hidden="true">
      <span className="bulk-select-hint-icon">☐</span>
      Tick rows to select them for bulk delete
    </div>
  );
}
