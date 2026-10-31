/**
 * Lightweight toast notification system.
 *
 * Usage:
 *   import { useToast, ToastShelf } from '../components/Toast.jsx';
 *
 *   const { toast, toasts, removeToast } = useToast();
 *   toast('Saved!', 'ok');
 *   toast('Error occurred', 'error');
 *   toast('FYI', 'info');
 *
 *   // In render tree (once, near root):
 *   <ToastShelf toasts={toasts} onRemove={removeToast} />
 */
import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon.jsx';

let _nextId = 1;

/**
 * @typedef {{ id: number, message: string, kind: 'ok' | 'error' | 'info' }} Toast
 */

/**
 * Hook providing toast state + emit function.
 */
export function useToast() {
  const [toasts, setToasts] = useState(/** @type {Toast[]} */([]));

  const removeToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((message, kind = 'info', duration = 4000) => {
    const id = _nextId++;
    setToasts((prev) => [...prev, { id, message, kind }]);
    if (duration > 0) {
      setTimeout(() => removeToast(id), duration);
    }
  }, [removeToast]);

  return { toasts, toast, removeToast };
}

const KIND_ICON = { ok: 'check', error: 'warning', info: 'info' };

/**
 * Renders all active toasts. Place once near the root.
 * @param {{ toasts: Toast[], onRemove: (id: number) => void }} props
 */
export function ToastShelf({ toasts, onRemove }) {
  if (!toasts.length) return null;
  return (
    <div className="toast-shelf" role="region" aria-label="Notifications" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.kind}`}
          role="status"
          aria-atomic="true"
        >
          <Icon name={KIND_ICON[t.kind] || 'info'} size={16} aria-hidden="true" />
          <span style={{ flex: 1 }}>{t.message}</span>
          <button
            type="button"
            className="btn-icon"
            style={{ flexShrink: 0 }}
            onClick={() => onRemove(t.id)}
            aria-label="Dismiss notification"
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
