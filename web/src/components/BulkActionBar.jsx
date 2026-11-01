import { Icon } from './Icon.jsx';

/**
 * Floating bulk-action bar.
 * Appears at the bottom of its positioned container when selected.size > 0.
 *
 * @param {{
 *   selected:      Set<string>,
 *   onDelete:      () => void,
 *   onClear:       () => void,
 *   busy?:         boolean,
 *   noun?:         string,           // singular label for the items (default 'item')
 *   deleteLabel?:  string,           // delete button text (default 'Delete')
 *   extraActions?: import('react').ReactNode,  // optional extra buttons shown before Delete
 * }} props
 */
export function BulkActionBar({
  selected,
  onDelete,
  onClear,
  busy = false,
  noun = 'item',
  deleteLabel = 'Delete',
  extraActions,
}) {
  if (selected.size === 0) return null;

  const nounPlural = noun + (noun.endsWith('s') ? '' : 's');
  const countLabel = `${selected.size} ${selected.size === 1 ? noun : nounPlural} selected`;

  return (
    <div className="bulk-action-bar" role="toolbar" aria-label="Bulk actions">
      <span className="bulk-action-count">
        <Icon name="check" size={14} />
        {countLabel}
      </span>
      <span className="bulk-action-sep" aria-hidden="true">·</span>
      {extraActions}
      <button
        type="button"
        className="btn btn-sm btn-danger"
        onClick={onDelete}
        disabled={busy}
        aria-label={`${deleteLabel} ${countLabel}`}
      >
        <Icon name="trash" size={13} />
        {deleteLabel} selected
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
