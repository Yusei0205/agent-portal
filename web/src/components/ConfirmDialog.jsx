/**
 * Accessible confirmation dialog — replaces native window.confirm().
 *
 * Usage:
 *   const { confirmState, requestConfirm } = useConfirm();
 *
 *   const yes = await requestConfirm('Delete this template?', 'Delete', 'danger');
 *   if (yes) { ... }
 *
 *   // In render tree (once):
 *   <ConfirmDialog state={confirmState} />
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * @typedef {{
 *   open: boolean,
 *   message: string,
 *   confirmLabel: string,
 *   variant: 'danger' | 'primary',
 *   resolve: (ok: boolean) => void,
 * }} ConfirmState
 */

export function useConfirm() {
  const [confirmState, setConfirmState] = useState(/** @type {ConfirmState} */({
    open: false, message: '', confirmLabel: 'Confirm', variant: 'primary',
    resolve: () => {},
  }));

  // Keep the current state's resolve in a ref so we can call it without
  // reading state inside a setState updater (which React StrictMode
  // double-invokes, causing spurious close → re-open cycles).
  const stateRef = useRef(confirmState);
  stateRef.current = confirmState;

  const requestConfirm = useCallback((message, confirmLabel = 'Confirm', variant = 'primary') => {
    return new Promise((resolve) => {
      // Resolve any currently-open dialog as false BEFORE opening the new one.
      // We do this outside the updater to avoid a nested setState side-effect.
      const current = stateRef.current;
      if (current.open) {
        current.resolve(false);
      }

      const wrappedResolve = (ok) => {
        setConfirmState((s) => ({ ...s, open: false }));
        resolve(ok);
      };

      setConfirmState({
        open: true,
        message,
        confirmLabel,
        variant,
        resolve: wrappedResolve,
      });
    });
  }, []);

  return { confirmState, requestConfirm };
}

/**
 * @param {{ state: ConfirmState }} props
 */
export function ConfirmDialog({ state }) {
  const { open, message, confirmLabel, variant, resolve } = state;
  const cancelRef = useRef(null);

  // Reliable Escape handler on the document so it fires regardless of which
  // element currently has focus (the backdrop div's onKeyDown only fires when
  // focus is already inside it).
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') resolve(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, resolve]);

  if (!open) return null;

  const answer = (ok) => { resolve(ok); };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
    >
      <div className="modal" style={{ maxWidth: 420 }}>
        <div className="modal-header">
          <h2 id="confirm-dialog-title" style={{ fontSize: '1rem' }}>Confirm</h2>
        </div>
        <p style={{ margin: '4px 0 20px', color: 'var(--ink-2)', fontSize: '0.9rem' }}>
          {message}
        </p>
        <div className="modal-footer">
          <button
            ref={cancelRef}
            type="button"
            className="btn"
            onClick={() => answer(false)}
            autoFocus
          >
            Cancel
          </button>
          <button
            type="button"
            className={`btn btn-${variant}`}
            onClick={() => answer(true)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
