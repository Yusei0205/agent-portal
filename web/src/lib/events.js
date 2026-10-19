import { useEffect, useRef } from 'react';

// Project-wide live events, fed by one EventSource opened in App.
const listeners = new Set();

export function emitProjectEvent(event, data) {
  for (const fn of [...listeners]) fn(event, data);
}

/** Call `fn` when any of `events` arrives for the current project. */
export function useProjectEvents(events, fn) {
  const ref = useRef(fn);
  ref.current = fn;
  const key = events.join(',');
  useEffect(() => {
    const wanted = new Set(key.split(','));
    const l = (event, data) => {
      if (wanted.has(event)) ref.current(event, data);
    };
    listeners.add(l);
    return () => listeners.delete(l);
  }, [key]);
}
