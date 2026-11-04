/**
 * useFocusTrap — confines Tab/Shift+Tab focus inside a container while it is
 * mounted, and restores focus to the element that was active before mount.
 *
 * Usage:
 *   const dialogRef = useFocusTrap();
 *   return <div ref={dialogRef} role="dialog" ...>…</div>;
 *
 * The hook does NOT add an Escape listener — dialogs should handle that
 * themselves (or via the global shortcuts handler in App.jsx).
 */

import { useEffect, useRef } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * @returns {React.RefObject<HTMLElement>}
 */
export function useFocusTrap() {
  const ref = useRef(null);
  // Remember which element had focus before the dialog opened
  const previousFocusRef = useRef(null);

  useEffect(() => {
    previousFocusRef.current = document.activeElement;

    // Focus first focusable element in the container
    const el = ref.current;
    if (!el) return;
    const first = el.querySelector(FOCUSABLE);
    if (first) {
      first.focus();
    }

    const handleKeyDown = (e) => {
      if (e.key !== 'Tab') return;
      const focusable = Array.from(el.querySelectorAll(FOCUSABLE));
      if (focusable.length === 0) { e.preventDefault(); return; }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey) {
        // Shift+Tab: wrap backward
        if (document.activeElement === first || !el.contains(document.activeElement)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        // Tab: wrap forward
        if (document.activeElement === last || !el.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      // Restore focus to the element that was focused before the dialog opened
      const prev = previousFocusRef.current;
      if (prev && typeof prev.focus === 'function') {
        try { prev.focus(); } catch { /* ignore */ }
      }
    };
  }, []);

  return ref;
}
