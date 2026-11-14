/**
 * Esc or Ctrl+C stops the agent's current turn, like in the terminal agents (Claude Code, Kiro, Codex).
 *
 * Ctrl+C is also "copy" in the browser, so it only stops when there is nothing selected to copy. Esc only stops when nothing else is using it
 * (a menu, a dialog, an input in the middle of a composition). Both do nothing unless a turn is running.
 */
import { useEffect, useRef } from 'react';

/** Whether this key press should stop the turn. Pure: everything it needs is passed in. */
export function shouldStopOnKey(event, { running, selectionText = '', inputSelected = false, dialogOpen = false, plainFocus = true }) {
  if (!running || dialogOpen || event.defaultPrevented || event.isComposing || event.repeat) return false;
  // Esc closes menus and popovers too, so it only stops the turn from the composer or from the bare page, never from a control that may be using it.
  if (event.key === 'Escape') return plainFocus && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
  const c = typeof event.key === 'string' && event.key.toLowerCase() === 'c';
  // Ctrl+C only (Cmd+C is copy on a Mac and Ctrl+C there is free): not while there is a selection to copy.
  return c && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !selectionText && !inputSelected;
}

function liveState() {
  const el = document.activeElement;
  const inputSelected = Boolean(el && typeof el.selectionStart === 'number' && el.selectionStart !== el.selectionEnd);
  return {
    selectionText: window.getSelection?.()?.toString() ?? '',
    inputSelected,
    dialogOpen: Boolean(document.querySelector('[role="dialog"][aria-modal="true"]')),
    plainFocus: !el || el === document.body || el.tagName === 'TEXTAREA',
  };
}

/** Calls onStop on Esc or Ctrl+C while `running`. */
export function useStopShortcut(running, onStop) {
  const stop = useRef(onStop);
  stop.current = onStop;
  useEffect(() => {
    if (!running) return undefined;
    const onKey = (e) => {
      if (!shouldStopOnKey(e, { running, ...liveState() })) return;
      e.preventDefault();
      stop.current?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [running]);
}
