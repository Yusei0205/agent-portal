import { cx } from '../../lib/util.js';
import { Icon } from '../../components/Icon.jsx';
import { CONTEXT_ICON, CONTEXT_KIND_LABEL } from '../../components/ContextPicker.jsx';

/**
 * Renders the result of a slash-command execution inside the session view.
 *
 * Props:
 *   result   – CommandResult from the backend
 *   onClose  – called when the user dismisses the result
 */
export function CommandResultView({ result, onClose }) {
  if (!result) return null;

  const isError = result._error;

  return (
    <div
      className={cx('cmd-result', isError && 'cmd-result-error')}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="cmd-result-head">
        <Icon
          name={isError ? 'alert' : 'check'}
          size={15}
          aria-hidden="true"
        />
        <span className="cmd-result-label small">
          {isError ? 'Command error' : 'Command result'}
        </span>
        {onClose ? (
          <button
            type="button"
            className="icon-btn cmd-result-close"
            onClick={onClose}
            aria-label="Dismiss command result"
          >
            <Icon name="x" size={14} />
          </button>
        ) : null}
      </div>

      {/* Human-readable text — preserve newlines */}
      {result.text ? (
        <pre className="cmd-result-text small">{result.text}</pre>
      ) : null}

      {/* Deferred change notice */}
      {result.deferred ? (
        <p className="cmd-result-deferred small muted">
          <Icon name="alert" size={13} aria-hidden="true" />
          {' '}This will take effect at the next iteration (the session is currently running).
        </p>
      ) : null}

      {/* Context items listing (type === 'context') */}
      {result.type === 'context' && Array.isArray(result.context) && result.context.length ? (
        <ul className="cmd-result-ctx plain-list">
          {result.context.map((c) => (
            <li key={c.id} className="cmd-result-ctx-item">
              <Icon name={CONTEXT_ICON[c.kind] ?? 'file'} size={14} aria-hidden="true" />
              <span>
                <strong>{c.title}</strong>
                <span className="muted small"> · {CONTEXT_KIND_LABEL[c.kind] ?? c.kind}</span>
                {c.path ? <span className="muted small"> · <code>{c.path}</code></span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
