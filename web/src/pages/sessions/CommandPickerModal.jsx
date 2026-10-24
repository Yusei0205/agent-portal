import { cx } from '../../lib/util.js';
import { Button, Modal, Spinner, ErrorNote } from '../../components/ui.jsx';
import { Icon } from '../../components/Icon.jsx';

/**
 * Modal shown when a picker command (/model, /agent, /engine) returns type==='options'.
 *
 * Props:
 *   title      – modal heading
 *   intro      – introductory text from the backend
 *   options    – CommandOption[]
 *   onSelect(option) – called with the chosen option
 *   onClose()  – called when the user dismisses without choosing
 *   busy       – true while the follow-up command POST is in-flight
 *   error      – Error | null from the follow-up POST
 */
export function CommandPickerModal({ title, intro, options, onSelect, onClose, busy, error }) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      <div className="stack">
        {intro ? <p className="muted small">{intro}</p> : null}
        {error ? <ErrorNote error={error} /> : null}
        <ul className="cmd-picker-list plain-list" role="listbox" aria-label={title}>
          {(options || []).map((opt) => (
            <li key={opt.id} role="option" aria-selected={opt.current}>
              <button
                type="button"
                className={cx('cmd-picker-option', opt.current && 'is-current')}
                onClick={() => onSelect(opt)}
                disabled={busy}
                aria-pressed={opt.current}
              >
                <span className="cmd-picker-option-main">
                  <span className="cmd-picker-label mono">{opt.label}</span>
                  {opt.current ? (
                    <span className="cmd-picker-current-badge">
                      <Icon name="check" size={13} />
                      <span className="small">current</span>
                    </span>
                  ) : null}
                </span>
                {opt.description ? (
                  <span className="cmd-picker-desc muted small">{opt.description}</span>
                ) : null}
                {busy && opt.current ? <Spinner small /> : null}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
