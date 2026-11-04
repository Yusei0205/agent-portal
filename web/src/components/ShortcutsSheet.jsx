import { useEffect, useRef, useState } from 'react';
import { getShortcutDefs, subscribeShortcuts } from '../lib/shortcuts.js';
import { Icon } from './Icon.jsx';
import { useOverlayDismiss } from '../lib/useOverlayDismiss.js';

// ── Focus trap ────────────────────────────────────────────────────────────────

function useFocusTrap(ref, isOpen) {
  useEffect(() => {
    if (!isOpen || !ref.current) return;
    const el = ref.current;
    const getFocusable = () =>
      Array.from(el.querySelectorAll(
        'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ));

    const onKeyDown = (e) => {
      if (e.key !== 'Tab') return;
      const focusable = getFocusable();
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last  = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { last.focus(); e.preventDefault(); }
      } else {
        if (document.activeElement === last)  { first.focus(); e.preventDefault(); }
      }
    };
    el.addEventListener('keydown', onKeyDown);
    return () => el.removeEventListener('keydown', onKeyDown);
  }, [ref, isOpen]);
}

// ── Shortcuts sheet ───────────────────────────────────────────────────────────

/**
 * @param {{ isOpen: boolean, onClose: () => void }} props
 */
export function ShortcutsSheet({ isOpen, onClose }) {
  const [defs, setDefs] = useState(() => getShortcutDefs());

  const dialogRef    = useRef(null);
  const closeBtnRef  = useRef(null);
  const prevFocusRef = useRef(null);

  useFocusTrap(dialogRef, isOpen);

  // Stay in sync when features register new shortcuts after mount
  useEffect(() => {
    const unsub = subscribeShortcuts(() => setDefs([...getShortcutDefs()]));
    return unsub;
  }, []);

  // Save/restore focus
  useEffect(() => {
    if (isOpen) {
      prevFocusRef.current = document.activeElement;
      setTimeout(() => closeBtnRef.current?.focus(), 0);
    } else {
      if (prevFocusRef.current && typeof prevFocusRef.current.focus === 'function') {
        prevFocusRef.current.focus();
      }
    }
  }, [isOpen]);

  // Must be before early return — hook cannot be called after conditional return
  const overlayDismiss = useOverlayDismiss(onClose);

  if (!isOpen) return null;

  // Group defs
  const groups = {};
  for (const def of defs) {
    const g = def.group || 'General';
    if (!groups[g]) groups[g] = [];
    groups[g].push(def);
  }

  // Canonical group order
  const GROUP_ORDER = ['Global', 'Navigate', 'Sessions', 'Workspace', 'General'];
  const sortedGroups = Object.entries(groups).sort(([a], [b]) => {
    const ai = GROUP_ORDER.indexOf(a);
    const bi = GROUP_ORDER.indexOf(b);
    const aIdx = ai === -1 ? 999 : ai;
    const bIdx = bi === -1 ? 999 : bi;
    return aIdx - bIdx;
  });

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  return (
    <div
      className="shortcuts-backdrop"
      onMouseDown={overlayDismiss.onMouseDown}
      onClick={overlayDismiss.onClick}
      role="presentation"
    >
      <div
        ref={dialogRef}
        className="shortcuts-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        onKeyDown={handleKeyDown}
      >
        <div className="shortcuts-head">
          <h2 id="shortcuts-title" className="shortcuts-title">Keyboard shortcuts</h2>
          <button
            ref={closeBtnRef}
            type="button"
            className="btn-icon"
            onClick={onClose}
            aria-label="Close shortcuts"
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="shortcuts-body">
          {sortedGroups.map(([group, items]) => (
            <section key={group} aria-labelledby={`shortcuts-group-${group}`}>
              <div
                id={`shortcuts-group-${group}`}
                className="shortcuts-group-label"
              >
                {group}
              </div>
              <ul className="shortcuts-list" role="list">
                {items.map((def) => (
                  <li key={def.id} className="shortcut-row">
                    <span className="shortcut-row-label">
                      {def.label}
                    </span>
                    <span className="shortcut-row-keys" aria-label={`Key: ${def.keys}`}>
                      {def.keys.split(' ').map((k, i) => (
                        <kbd key={i} className="palette-key">{k}</kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
